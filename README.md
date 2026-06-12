# Consulta e Sincronização de Notas | Rota Resolve — Ferramenta interna PlugNotas

Ferramenta web para a equipe de consultoria técnica atualizar o campo `identificacaoNota` de emissões de NFSe em lote, via rota interna da API PlugNotas.

## Como executar

**Jeito mais facil (Windows):** de dois cliques no `iniciar.bat`. Ele verifica o Node.js (instala via winget se necessario), sobe o servidor local na porta 3500 e abre o navegador padrao automaticamente.

**Manual:**

Não há build nem dependências. Basta abrir o `index.html` no navegador.

Recomendado servir via HTTP local para evitar restrições do navegador:

```
# Com Python instalado:
python -m http.server 3500

# Ou com Node:
npx serve .
```

Depois acesse http://localhost:3500

## Fluxo de uso

1. Informe a API Key (opcionalmente marque para lembrar no navegador).
2. Cole os IDs das notas (um por linha) ou importe um CSV/TXT.
3. (Opcional) Configure as tentativas por nota (1, 3 ou 5) e o intervalo entre tentativas em ms na etapa 4.
4. (Opcional) Informe a identificação: única (mesmo valor para todas) ou individual (tabela editável). Campos em branco enviam a requisição sem o campo identificacaoNota.
4. Clique em "Executar atualização" e acompanhe progresso, resultados e logs.
5. Ao final, exporte o resultado em CSV se necessário.

## Detalhes técnicos

- Endpoint: `POST https://api.plugnotas.com.br/nfse/resolve/{idNota}`
- Headers: `Content-Type: application/json` e `x-api-key`
- Body: `{ "identificacaoNota": "..." }` quando informado, ou `{}` quando em branco (campo opcional)
- Concorrência: 5 requisições paralelas
- Retry: até 3 tentativas com backoff exponencial para HTTP 429/500/502/503 e timeout
- Timeout: 120s por requisição (a rota resolve é síncrona e pode demorar)
- Resolve em andamento: quando a API responde "ja esta sendo executado", a ferramenta aguarda 10s e verifica novamente, por ate 2 minutos, antes de marcar como "Em processamento na API"
- Persistência local: API Key (opcional), última lista de IDs, modo selecionado e tema

## Observação sobre CORS

Por ser executada no navegador, a ferramenta depende de a API permitir requisições cross-origin (CORS). Se o navegador bloquear as chamadas, execute a ferramenta a partir de um domínio autorizado ou utilize um proxy interno.

## Documentação

O manual de uso completo está em `documentacao.pdf` (também acessível pelo botão Documentação no topo da ferramenta).
