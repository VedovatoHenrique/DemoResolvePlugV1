@echo off
:: ============================================================
:: Consulta e Sincronizacao de Notas - Rota Resolve - PlugNotas (interno)
:: Inicia a ferramenta: verifica o Node.js (instala se preciso),
:: sobe um servidor local e abre o navegador padrao.
:: Basta dar dois cliques neste arquivo.
:: ============================================================
title Consulta e Sincronizacao de Notas - Rota Resolve - PlugNotas
setlocal
set "PORTA=3500"

:: Garante que o script rode a partir da pasta do projeto
cd /d "%~dp0"

echo.
echo  ============================================================
echo   Consulta e Sincronizacao de Notas - Rota Resolve - Ferramenta de consultoria tecnica
echo  ============================================================
echo.

:: ---------- 1) Verifica se o Node.js esta instalado ----------
where node >nul 2>nul
if %errorlevel%==0 goto :node_ok

echo  Node.js nao encontrado. Tentando instalar automaticamente...
echo.

:: Tenta instalar via winget (disponivel no Windows 10/11)
where winget >nul 2>nul
if %errorlevel% neq 0 (
    echo  [ERRO] O winget nao esta disponivel neste computador.
    echo  Instale o Node.js manualmente em: https://nodejs.org
    echo  Depois execute este arquivo novamente.
    echo.
    pause
    exit /b 1
)

winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
if %errorlevel% neq 0 (
    echo.
    echo  [ERRO] Nao foi possivel instalar o Node.js automaticamente.
    echo  Instale manualmente em: https://nodejs.org e execute novamente.
    echo.
    pause
    exit /b 1
)

echo.
echo  Node.js instalado com sucesso!
echo  IMPORTANTE: feche esta janela e execute o iniciar.bat novamente
echo  para que o sistema reconheca a instalacao (atualizacao do PATH).
echo.
pause
exit /b 0

:node_ok
for /f "delims=" %%v in ('node --version') do set "NODEVER=%%v"
echo  Node.js encontrado (%NODEVER%).
echo.

:: ---------- 2) Abre o navegador padrao (com pequeno atraso) ----------
:: O atraso de 3s da tempo para o servidor subir antes da pagina carregar
start "" cmd /c "timeout /t 3 /nobreak >nul & start "" http://localhost:%PORTA%"

:: ---------- 3) Inicia o servidor local ----------
echo  Iniciando servidor em http://localhost:%PORTA%
echo  O navegador sera aberto automaticamente.
echo.
echo  Para encerrar a ferramenta, feche esta janela ou pressione Ctrl+C.
echo  ------------------------------------------------------------
echo.
npx -y serve . -l %PORTA%

endlocal
