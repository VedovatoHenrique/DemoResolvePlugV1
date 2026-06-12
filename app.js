/* ============================================================
   Atualização de Identificação NFSe — PlugNotas (interno)
   Lógica da aplicação: parsing de IDs, modos de identificação,
   processamento em lote com concorrência limitada, retry com
   backoff exponencial, timeout, logs, CSV e persistência local.
   ============================================================ */

"use strict";

/* ----------------------------------------------------------
   Constantes de configuração
---------------------------------------------------------- */
const API_BASE_URL   = "https://api.plugnotas.com.br/nfse/resolve";
const CONCURRENCY    = 5;          // requisições simultâneas
const RETRY_STATUSES = [429, 500, 502, 503];
const TIMEOUT_MS     = 120000;     // 120s: o resolve é síncrono e pode demorar na API
const DEFAULT_RETRIES  = 3;        // padrão de tentativas (configurável na interface)
const DEFAULT_INTERVAL = 1000;     // padrão de intervalo entre tentativas, em ms
// Quando a API responde "resolve já está sendo executado", aguarda e verifica de novo
const RESOLVE_WAIT_MS   = 10000;   // intervalo entre verificações (10s)
const RESOLVE_MAX_POLLS = 12;      // até ~2 minutos de espera adicional
const RESOLVE_IN_PROGRESS = /sendo executad/i; // detecta a mensagem, com ou sem acentos
const STORAGE_KEYS   = {
  apiKey: "nfse-ident:apiKey",
  ids:      "nfse-ident:ids",
  mode:     "nfse-ident:mode",
  retries:  "nfse-ident:retries",
  interval: "nfse-ident:interval"
};

/* ----------------------------------------------------------
   Estado global da aplicação
---------------------------------------------------------- */
const state = {
  mode: "unica",          // "unica" | "individual"
  ids: [],                // lista de IDs válidos e únicos
  individualMap: new Map(), // id -> identificacao digitada no modo individual
  running: false,
  cancelled: false,
  abortControllers: new Set(),
  results: [],            // resultados acumulados para o CSV
  stats: { total: 0, done: 0, success: 0, error: 0 },
  startTime: null
};

/* ----------------------------------------------------------
   Atalhos para elementos da interface
---------------------------------------------------------- */
const $ = (id) => document.getElementById(id);

const els = {
  themeToggle: $("themeToggle"),
  apiKeyInput: $("apiKeyInput"),
  toggleApiKey: $("toggleApiKey"),
  rememberApiKey: $("rememberApiKey"),
  idsTextarea: $("idsTextarea"),
  idCounter: $("idCounter"),
  clearIdsBtn: $("clearIdsBtn"),
  formatIdsBtn: $("formatIdsBtn"),
  fileImport: $("fileImport"),
  tabUnica: $("tabUnica"),
  tabIndividual: $("tabIndividual"),
  panelUnica: $("panelUnica"),
  panelIndividual: $("panelIndividual"),
  identUnicaInput: $("identUnicaInput"),
  individualTableBody: $("individualTableBody"),
  retrySelect: $("retrySelect"),
  retryIntervalInput: $("retryIntervalInput"),
  runBtn: $("runBtn"),
  cancelBtn: $("cancelBtn"),
  progressFill: $("progressFill"),
  statTotal: $("statTotal"),
  statDone: $("statDone"),
  statPending: $("statPending"),
  statSuccess: $("statSuccess"),
  statError: $("statError"),
  cardResultados: $("cardResultados"),
  resultsTableBody: $("resultsTableBody"),
  exportCsvBtn: $("exportCsvBtn"),
  summaryBox: $("summaryBox"),
  sumTotal: $("sumTotal"),
  sumSuccess: $("sumSuccess"),
  sumError: $("sumError"),
  sumRate: $("sumRate"),
  sumTime: $("sumTime"),
  logsPanel: $("logsPanel"),
  logCounter: $("logCounter"),
  clearLogsBtn: $("clearLogsBtn"),
  exportLogsBtn: $("exportLogsBtn"),
  toastContainer: $("toastContainer"),
  confirmModal: $("confirmModal"),
  confirmTitle: $("confirmTitle"),
  confirmMessage: $("confirmMessage"),
  confirmOk: $("confirmOk"),
  confirmCancel: $("confirmCancel")
};

/* ============================================================
   UTILITÁRIOS DE INTERFACE
   ============================================================ */

/** Exibe uma mensagem toast (success | error | info). */
function showToast(message, type = "info", duration = 4000) {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  els.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("leaving");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
  }, duration);
}

/** Abre o modal de confirmação e resolve true/false conforme a escolha. */
function confirmAction(title, message) {
  return new Promise((resolve) => {
    els.confirmTitle.textContent = title;
    els.confirmMessage.textContent = message;
    els.confirmModal.hidden = false;

    const close = (answer) => {
      els.confirmModal.hidden = true;
      els.confirmOk.onclick = null;
      els.confirmCancel.onclick = null;
      els.confirmModal.onclick = null;
      document.removeEventListener("keydown", onKey);
      resolve(answer);
    };
    const onKey = (e) => { if (e.key === "Escape") close(false); };

    els.confirmOk.onclick = () => close(true);
    els.confirmCancel.onclick = () => close(false);
    // Clique fora do modal (no backdrop) cancela
    els.confirmModal.onclick = (e) => { if (e.target === els.confirmModal) close(false); };
    document.addEventListener("keydown", onKey);
    els.confirmOk.focus();
  });
}

/** Registra uma linha no painel de logs. */
function log(message, level = "info") {
  const time = new Date().toLocaleTimeString("pt-BR");
  const line = document.createElement("span");
  line.className = level === "error" ? "log-error"
                 : level === "success" ? "log-success"
                 : level === "warn" ? "log-warn" : "";
  line.textContent = `[${time}] ${message}\n`;
  els.logsPanel.appendChild(line);
  els.logsPanel.scrollTop = els.logsPanel.scrollHeight;

  const count = els.logsPanel.childElementCount;
  els.logCounter.textContent = `${count} registro${count === 1 ? "" : "s"}`;
}

/* ============================================================
   TEMA CLARO / ESCURO
   ============================================================ */
function initTheme() {
  const saved = localStorage.getItem("nfse-ident:theme");
  if (saved) document.documentElement.dataset.theme = saved;
  els.themeToggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("nfse-ident:theme", next);
  });
}

/* ============================================================
   SEÇÃO 1 — API KEY
   ============================================================ */
function initApiKey() {
  // Restaura a API Key salva (se o usuário optou por lembrar)
  const savedKey = localStorage.getItem(STORAGE_KEYS.apiKey);
  if (savedKey) {
    els.apiKeyInput.value = savedKey;
    els.rememberApiKey.checked = true;
  }

  // Mostrar / ocultar conteúdo do campo
  els.toggleApiKey.addEventListener("click", () => {
    const isPassword = els.apiKeyInput.type === "password";
    els.apiKeyInput.type = isPassword ? "text" : "password";
  });

  // Persistência opcional
  const persist = () => {
    if (els.rememberApiKey.checked) {
      localStorage.setItem(STORAGE_KEYS.apiKey, els.apiKeyInput.value.trim());
    } else {
      localStorage.removeItem(STORAGE_KEYS.apiKey);
    }
  };
  els.apiKeyInput.addEventListener("input", persist);
  els.rememberApiKey.addEventListener("change", persist);
}

/* ============================================================
   SEÇÃO 2 — ENTRADA DOS IDS
   ============================================================ */

/** Converte o conteúdo do textarea em lista de IDs únicos e não vazios.
    Aceita separadores variados: quebra de linha, espaço, tab, vírgula e ponto e vírgula. */
function parseIds(rawText) {
  const seen = new Set();
  const ids = [];
  rawText.split(/[\s;,]+/).forEach((piece) => {
    const id = piece.trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  });
  return ids;
}

/** Recalcula a lista de IDs, o contador e a tabela do modo individual. */
function refreshIds() {
  state.ids = parseIds(els.idsTextarea.value);
  const n = state.ids.length;
  els.idCounter.textContent = `${n} ID${n === 1 ? "" : "s"} válido${n === 1 ? "" : "s"}`;
  localStorage.setItem(STORAGE_KEYS.ids, els.idsTextarea.value);
  renderIndividualTable();
}

/** Reconstrói a tabela editável do modo individual preservando valores digitados. */
function renderIndividualTable() {
  const tbody = els.individualTableBody;
  tbody.innerHTML = "";

  if (state.ids.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="2">Informe os IDs na seção 2 para montar a tabela.</td></tr>`;
    return;
  }

  state.ids.forEach((id) => {
    const tr = document.createElement("tr");

    const tdId = document.createElement("td");
    tdId.className = "mono";
    tdId.textContent = id;

    const tdInput = document.createElement("td");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cell-input";
    input.placeholder = "codigoVerificacao (opcional)";
    input.value = state.individualMap.get(id) || "";
    input.addEventListener("input", () => state.individualMap.set(id, input.value));
    tdInput.appendChild(input);

    tr.append(tdId, tdInput);
    tbody.appendChild(tr);
  });

  // Remove do mapa entradas de IDs que saíram da lista
  [...state.individualMap.keys()].forEach((key) => {
    if (!state.ids.includes(key)) state.individualMap.delete(key);
  });
}

function initIds() {
  // Restaura a última lista utilizada
  const savedIds = localStorage.getItem(STORAGE_KEYS.ids);
  if (savedIds) els.idsTextarea.value = savedIds;

  els.idsTextarea.addEventListener("input", refreshIds);

  // Formatar IDs: normaliza a colagem para um ID por linha, sem duplicados
  els.formatIdsBtn.addEventListener("click", () => {
    const before = els.idsTextarea.value;
    if (!before.trim()) {
      showToast("Nenhum conteúdo para formatar.", "info");
      return;
    }
    const ids = parseIds(before);
    els.idsTextarea.value = ids.join("\n");
    refreshIds();
    showToast(`Lista formatada: ${ids.length} ID(s) único(s), um por linha.`, "success");
    log(`Lista de IDs formatada: ${ids.length} ID(s) após normalização.`);
  });

  // Limpar lista com confirmação
  els.clearIdsBtn.addEventListener("click", async () => {
    if (!els.idsTextarea.value.trim()) return;
    const ok = await confirmAction("Limpar lista de IDs", "Todos os IDs informados serão removidos. Deseja continuar?");
    if (!ok) return;
    els.idsTextarea.value = "";
    state.individualMap.clear();
    refreshIds();
    showToast("Lista de IDs limpa.", "info");
  });

  // Importação de arquivo CSV / TXT
  els.fileImport.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      els.idsTextarea.value = String(reader.result || "").trim();
      refreshIds();
      showToast(`Arquivo "${file.name}" importado: ${state.ids.length} ID(s).`, "success");
      log(`Arquivo importado: ${file.name} (${state.ids.length} IDs válidos)`);
    };
    reader.onerror = () => showToast("Não foi possível ler o arquivo.", "error");
    reader.readAsText(file);
    event.target.value = ""; // permite importar o mesmo arquivo novamente
  });

  refreshIds();
}

/* ============================================================
   SEÇÃO 3 — MODOS DE IDENTIFICAÇÃO
   ============================================================ */
function setMode(mode) {
  state.mode = mode;
  const unica = mode === "unica";
  els.tabUnica.classList.toggle("active", unica);
  els.tabIndividual.classList.toggle("active", !unica);
  els.tabUnica.setAttribute("aria-selected", String(unica));
  els.tabIndividual.setAttribute("aria-selected", String(!unica));
  els.panelUnica.hidden = !unica;
  els.panelIndividual.hidden = unica;
  localStorage.setItem(STORAGE_KEYS.mode, mode);
}

function initModes() {
  els.tabUnica.addEventListener("click", () => setMode("unica"));
  els.tabIndividual.addEventListener("click", () => setMode("individual"));
  const savedMode = localStorage.getItem(STORAGE_KEYS.mode);
  setMode(savedMode === "individual" ? "individual" : "unica");
}

/* ============================================================
   CONFIGURAÇÃO DE TENTATIVAS (definida pelo usuário)
   ============================================================ */

/** Lê e valida a configuração de tentativas e intervalo da interface. */
function getRetryConfig() {
  const maxRetries = [1, 3, 5].includes(Number(els.retrySelect.value))
    ? Number(els.retrySelect.value)
    : DEFAULT_RETRIES;
  let retryInterval = parseInt(els.retryIntervalInput.value, 10);
  if (!Number.isFinite(retryInterval) || retryInterval < 0) retryInterval = DEFAULT_INTERVAL;
  return { maxRetries, retryInterval };
}

/** Restaura a última configuração e persiste alterações. */
function initRetryConfig() {
  const savedRetries = localStorage.getItem(STORAGE_KEYS.retries);
  if (["1", "3", "5"].includes(savedRetries)) els.retrySelect.value = savedRetries;

  const savedInterval = parseInt(localStorage.getItem(STORAGE_KEYS.interval), 10);
  if (Number.isFinite(savedInterval) && savedInterval >= 0) els.retryIntervalInput.value = savedInterval;

  els.retrySelect.addEventListener("change", () =>
    localStorage.setItem(STORAGE_KEYS.retries, els.retrySelect.value));
  els.retryIntervalInput.addEventListener("input", () =>
    localStorage.setItem(STORAGE_KEYS.interval, els.retryIntervalInput.value));
}

/* ============================================================
   COMUNICAÇÃO COM A API
   ============================================================ */

/** Pausa assíncrona utilizada no backoff exponencial. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Executa o POST de atualização para um ID, com timeout, retry
 * automático em erros temporários e suporte a cancelamento.
 * Quando a API informa que o resolve já está em execução para o
 * documento, aguarda e verifica novamente (o resolve é síncrono
 * e pode levar alguns minutos para concluir no PlugNotas).
 * Retorna um objeto de resultado pronto para a tabela e o CSV.
 */
async function updateNota(id, identificacao, apiKey, maxRetries, retryInterval) {
  const url = `${API_BASE_URL}/${encodeURIComponent(id)}`;
  const started = performance.now();
  let lastError = null;
  let attempt = 0;  // tentativas consumidas por erros temporários (timeout/429/5xx)
  let polls = 0;    // verificações enquanto o resolve está em andamento na API

  while (true) {
    if (state.cancelled) {
      return buildResult(id, identificacao, null, "cancelado", "Processamento cancelado pelo usuário", started);
    }
    attempt++;

    // AbortController combina timeout e cancelamento manual
    const controller = new AbortController();
    state.abortControllers.add(controller);
    const timeoutId = setTimeout(() => controller.abort("timeout"), TIMEOUT_MS);

    try {
      log(`POST ${url} (tentativa ${attempt}/${maxRetries})`);
      // identificacaoNota é opcional: quando vazia, envia body sem o campo
      const body = identificacao ? { identificacaoNota: identificacao } : {};
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      // Tenta extrair a mensagem retornada pela API
      let apiMessage = "";
      try {
        const data = await response.json();
        apiMessage = extractApiMessage(data);
      } catch {
        apiMessage = response.statusText || "";
      }

      if (response.ok) {
        log(`ID ${id} -> HTTP ${response.status} (sucesso)`, "success");
        return buildResult(id, identificacao, response.status, "sucesso", apiMessage || "Atualizado com sucesso", started);
      }

      // Resolve já em execução na API: não é erro, é "aguarde e verifique de novo"
      if (RESOLVE_IN_PROGRESS.test(apiMessage)) {
        if (polls < RESOLVE_MAX_POLLS) {
          polls++;
          attempt--; // não consome tentativa de erro temporário
          log(`ID ${id} -> resolve em andamento na API. Nova verificação em ${RESOLVE_WAIT_MS / 1000}s (${polls}/${RESOLVE_MAX_POLLS}).`, "warn");
          await sleep(RESOLVE_WAIT_MS);
          continue;
        }
        log(`ID ${id} -> resolve ainda em processamento na API após ${Math.round(RESOLVE_MAX_POLLS * RESOLVE_WAIT_MS / 1000)}s de espera.`, "warn");
        return buildResult(id, identificacao, response.status, "processando-api",
          "Resolve ainda em processamento na API. Consulte a nota novamente em alguns minutos.", started);
      }

      // Erro temporário: agenda nova tentativa com o intervalo configurado
      if (RETRY_STATUSES.includes(response.status) && attempt < maxRetries) {
        log(`ID ${id} -> HTTP ${response.status}. Nova tentativa em ${retryInterval}ms.`, "warn");
        await sleep(retryInterval);
        continue;
      }

      log(`ID ${id} -> HTTP ${response.status} (erro): ${apiMessage}`, "error");
      return buildResult(id, identificacao, response.status, "erro", apiMessage || "Erro retornado pela API", started);

    } catch (err) {
      const isTimeout = controller.signal.aborted && controller.signal.reason === "timeout";
      const isCancel = state.cancelled;

      if (isCancel) {
        return buildResult(id, identificacao, null, "cancelado", "Processamento cancelado pelo usuário", started);
      }

      lastError = isTimeout ? `Timeout (${TIMEOUT_MS / 1000}s) excedido` : (err?.message || "Falha de rede");

      // Timeout e falhas de rede também entram no retry
      if (attempt < maxRetries) {
        log(`ID ${id} -> ${lastError}. Nova tentativa em ${retryInterval}ms.`, "warn");
        await sleep(retryInterval);
        continue;
      }

      log(`ID ${id} -> ${lastError} (tentativas esgotadas)`, "error");
      return buildResult(id, identificacao, null, "erro", lastError || "Falha desconhecida", started);
    } finally {
      clearTimeout(timeoutId);
      state.abortControllers.delete(controller);
    }
  }
}

/** Procura a mensagem mais relevante no JSON de resposta da API. */
function extractApiMessage(data) {
  if (!data) return "";
  if (typeof data === "string") return data;
  if (data.message) return String(data.message);
  if (data.error?.message) return String(data.error.message);
  if (Array.isArray(data) && data[0]?.message) return String(data[0].message);
  return JSON.stringify(data).slice(0, 200);
}

/** Monta o objeto de resultado padronizado. */
function buildResult(id, identificacao, status, outcome, message, started) {
  return {
    id,
    identificacao,
    status,
    outcome, // "sucesso" | "erro" | "cancelado"
    message,
    timeMs: Math.round(performance.now() - started),
    when: new Date().toLocaleString("pt-BR")
  };
}

/* ============================================================
   PROCESSAMENTO EM LOTE (POOL DE CONCORRÊNCIA)
   ============================================================ */

/** Executa a fila de IDs com no máximo CONCURRENCY chamadas simultâneas. */
async function processQueue(items, apiKey, maxRetries, retryInterval) {
  let index = 0;

  // Cada worker consome itens da fila até ela esgotar ou o usuário cancelar
  const worker = async () => {
    while (index < items.length && !state.cancelled) {
      const rowIndex = index++;
      const current = items[rowIndex];
      setRowStatus(rowIndex, "processando");
      const result = await updateNota(current.id, current.identificacao, apiKey, maxRetries, retryInterval);
      registerResult(result, rowIndex);
    }
  };

  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker);
  await Promise.all(workers);
}

/* ============================================================
   TABELA DE RESULTADOS E ESTATÍSTICAS
   ============================================================ */

/** Cria as linhas iniciais (status pendente) da tabela de resultados. */
function buildResultsTable(items) {
  els.resultsTableBody.innerHTML = "";
  items.forEach((item, idx) => {
    const tr = document.createElement("tr");
    tr.id = `row-${idx}`;
    tr.innerHTML = `
      <td class="mono">${escapeHtml(item.id)}</td>
      <td>${item.identificacao ? escapeHtml(item.identificacao) : "—"}</td>
      <td class="cell-status">—</td>
      <td class="cell-outcome"><span class="badge badge-neutral">Pendente</span></td>
      <td class="cell-message">—</td>
      <td class="cell-time">—</td>`;
    els.resultsTableBody.appendChild(tr);
  });
  els.cardResultados.hidden = false;
}

/** Atualiza apenas o badge de status de uma linha (ex.: "processando"). */
function setRowStatus(rowIndex, status) {
  const row = document.getElementById(`row-${rowIndex}`);
  if (!row) return;
  if (status === "processando") {
    row.querySelector(".cell-outcome").innerHTML =
      `<span class="badge badge-warning pulsing">Processando</span>`;
  }
}

/** Aplica o resultado final na linha e atualiza estatísticas e progresso. */
function registerResult(result, rowIndex) {
  state.results.push(result);
  state.stats.done++;
  if (result.outcome === "sucesso") state.stats.success++;
  else state.stats.error++;

  const row = document.getElementById(`row-${rowIndex}`);
  if (row) {
    row.querySelector(".cell-status").textContent = result.status ?? "—";
    row.querySelector(".cell-message").textContent = result.message || "—";
    row.querySelector(".cell-time").textContent = `${result.timeMs}ms`;
    const badge =
      result.outcome === "sucesso" ? `<span class="badge badge-success">✓ Sucesso</span>` :
      result.outcome === "processando-api" ? `<span class="badge badge-warning">⏳ Em processamento na API</span>` :
      result.outcome === "cancelado" ? `<span class="badge badge-neutral">Cancelado</span>` :
      `<span class="badge badge-error">✕ Erro</span>`;
    row.querySelector(".cell-outcome").innerHTML = badge;
  }

  updateStatsUI();
}

/** Sincroniza contadores e barra de progresso com o estado atual. */
function updateStatsUI() {
  const { total, done, success, error } = state.stats;
  els.statTotal.textContent = total;
  els.statDone.textContent = done;
  els.statPending.textContent = Math.max(total - done, 0);
  els.statSuccess.textContent = success;
  els.statError.textContent = error;
  const pct = total ? Math.round((done / total) * 100) : 0;
  els.progressFill.style.width = `${pct}%`;
}

/** Escapa HTML para evitar injeção ao renderizar valores na tabela. */
function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

/* ============================================================
   FLUXO PRINCIPAL DE EXECUÇÃO
   ============================================================ */

/** Valida entradas e monta a lista { id, identificacao } a processar. */
function validateAndBuildItems() {
  const apiKey = els.apiKeyInput.value.trim();
  if (!apiKey) {
    showToast("Informe a API Key antes de executar.", "error");
    els.apiKeyInput.focus();
    return null;
  }

  refreshIds();
  if (state.ids.length === 0) {
    showToast("Informe ao menos um ID válido.", "error");
    els.idsTextarea.focus();
    return null;
  }

  let items;
  if (state.mode === "unica") {
    // Identificação é opcional: em branco, a nota é resolvida sem alterar o campo
    const ident = els.identUnicaInput.value.trim();
    items = state.ids.map((id) => ({ id, identificacao: ident }));
  } else {
    // Modo individual: campos em branco também são permitidos
    items = state.ids.map((id) => ({ id, identificacao: (state.individualMap.get(id) || "").trim() }));
  }

  return { apiKey, items };
}

/** Habilita/desabilita controles conforme a execução. */
function setRunningUI(running) {
  state.running = running;
  els.runBtn.disabled = running;
  els.cancelBtn.disabled = !running;
  els.apiKeyInput.disabled = running;
  els.idsTextarea.disabled = running;
  els.identUnicaInput.disabled = running;
  els.clearIdsBtn.disabled = running;
  els.formatIdsBtn.disabled = running;
  els.tabUnica.disabled = running;
  els.tabIndividual.disabled = running;
  els.retrySelect.disabled = running;
  els.retryIntervalInput.disabled = running;
  els.exportCsvBtn.disabled = running || state.results.length === 0;
  els.progressFill.classList.toggle("running", running);
}

async function runUpdate() {
  const payload = validateAndBuildItems();
  if (!payload) return;
  const { apiKey, items } = payload;

  const semIdent = items.filter((item) => !item.identificacao).length;
  const detalhe = semIdent === 0 ? ""
    : semIdent === items.length ? " Todas serão enviadas sem identificacaoNota."
    : ` ${semIdent} dela(s) será(ão) enviada(s) sem identificacaoNota.`;

  const ok = await confirmAction(
    "Executar atualização",
    `Serão processadas ${items.length} nota(s).${detalhe} Deseja continuar?`
  );
  if (!ok) return;

  // Reinicializa estado da execução
  state.cancelled = false;
  state.results = [];
  state.stats = { total: items.length, done: 0, success: 0, error: 0 };
  state.startTime = performance.now();
  els.summaryBox.hidden = true;

  buildResultsTable(items);
  updateStatsUI();
  setRunningUI(true);
  const { maxRetries, retryInterval } = getRetryConfig();
  log(`Execução iniciada: ${items.length} nota(s), concorrência ${CONCURRENCY}, até ${maxRetries} tentativa(s) por nota com intervalo de ${retryInterval}ms.`);

  await processQueue(items, apiKey, maxRetries, retryInterval);

  finishRun();
}

/** Encerra a execução, monta o resumo e libera a interface. */
function finishRun() {
  setRunningUI(false);
  const totalSeconds = ((performance.now() - state.startTime) / 1000).toFixed(1);
  const { done, success, error } = state.stats;
  const rate = done ? Math.round((success / done) * 100) : 0;

  els.sumTotal.textContent = done;
  els.sumSuccess.textContent = success;
  els.sumError.textContent = error;
  els.sumRate.textContent = `${rate}%`;
  els.sumTime.textContent = `${totalSeconds}s`;
  els.summaryBox.hidden = false;
  els.exportCsvBtn.disabled = state.results.length === 0;

  if (state.cancelled) {
    log(`Execução cancelada. ${done} de ${state.stats.total} processadas.`, "warn");
    showToast("Processamento cancelado.", "error");
  } else {
    log(`Execução concluída em ${totalSeconds}s: ${success} sucesso(s), ${error} erro(s).`, success === done ? "success" : "warn");
    showToast(error === 0 ? "Atualização concluída com sucesso!" : `Concluído com ${error} erro(s).`, error === 0 ? "success" : "error");
  }
}

/** Cancela a execução em andamento e aborta as requisições ativas. */
function cancelRun() {
  if (!state.running) return;
  state.cancelled = true;
  state.abortControllers.forEach((controller) => controller.abort("cancel"));
  log("Cancelamento solicitado pelo usuário.", "warn");
}

/* ============================================================
   EXPORTAÇÃO CSV
   ============================================================ */
function exportCsv() {
  if (state.results.length === 0) return;

  const header = ["ID", "Identificacao Enviada", "Status HTTP", "Resultado", "Mensagem API", "Data e Hora"];
  const escapeCsv = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;

  const lines = [header.map(escapeCsv).join(";")];
  state.results.forEach((r) => {
    lines.push([r.id, r.identificacao, r.status ?? "", r.outcome, r.message, r.when].map(escapeCsv).join(";"));
  });

  // BOM para acentuação correta no Excel
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  a.href = url;
  a.download = `resultado-identificacao-nfse-${stamp}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("CSV exportado.", "success");
  log(`CSV exportado com ${state.results.length} registro(s).`);
}

/* ============================================================
   EXPORTAÇÃO DOS LOGS (TXT)
   ============================================================ */
function exportLogs() {
  const content = els.logsPanel.textContent.trim();
  if (!content) {
    showToast("Não há logs para exportar.", "info");
    return;
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  const header = `Logs da execucao - Atualizacao de Identificacao NFSe (PlugNotas)\nExportado em: ${new Date().toLocaleString("pt-BR")}\n${"=".repeat(60)}\n\n`;
  const blob = new Blob([header + content + "\n"], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `logs-identificacao-nfse-${stamp}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("Logs exportados.", "success");
}

/* ============================================================
   INICIALIZAÇÃO
   ============================================================ */
function init() {
  initTheme();
  initApiKey();
  initIds();
  initModes();
  initRetryConfig();

  els.runBtn.addEventListener("click", runUpdate);
  els.cancelBtn.addEventListener("click", cancelRun);
  els.exportCsvBtn.addEventListener("click", exportCsv);
  els.exportLogsBtn.addEventListener("click", exportLogs);
  els.clearLogsBtn.addEventListener("click", () => {
    els.logsPanel.innerHTML = "";
    els.logCounter.textContent = "0 registros";
  });

  log("Ferramenta carregada e pronta para uso.");
}

document.addEventListener("DOMContentLoaded", init);
