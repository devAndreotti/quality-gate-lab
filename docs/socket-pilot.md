# Piloto Socket (advisory)

## Objetivo
Medir se o Socket encontra riscos de pacote que o Dependabot e a Dependency Review não veem (typosquat, install scripts, telemetria, malware). Não substitui o Dependabot: complementa.

## Como instalar (só o dono do repo)
1. Instalar o app em https://github.com/apps/socket-security e selecionar **somente** `devAndreotti/quality-gate-lab`.
2. Não adicionar o check do Socket a branch protection. Ele é advisory por isso, não por configuração.

## O que registrar (durante 14 dias)
Para cada comentário do Socket em PR, anotar:

| Data | PR | Alerta (issueRule) | Pacote | Verdadeiro positivo? | Observação |
|---|---|---|---|---|---|

Anotar também os comentários por PR, e se algum PR foi atrasado por causa do Socket (esperado: nenhum).

## Critérios de decisão (ao fim de 14 dias)
- **Manter e avaliar CI:** ao menos 1 verdadeiro positivo real **e** falsos positivos em no máximo 1 de cada 3 comentários.
- **Manter só como app:** nenhum verdadeiro positivo, mas ruído aceitável (até 1 comentário por PR em média).
- **Remover o app:** ruído alto (mais de 1 comentário por PR em média) ou nenhum achado útil.

## Fora de escopo do piloto
- Socket CLI em CI com token (exige secret e pode enviar dados de manifest à API).
- Bloqueio de merge.
- Repositório público `devAndreotti/quality-gate`: só entra depois da decisão, porque o app comentaria em todos os PRs.
