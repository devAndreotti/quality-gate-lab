---
name: babysit-pr
description: |
  Monitora e itera sobre um pull request do GitHub até ele estar pronto para merge.
  Use esta skill SEMPRE que o usuário pedir para "monitorar", "acompanhar", "babysitar",
  "ficar de olho", "cuidar", "resolver comentários" ou "deixa rodando" em relação a um PR.
  Também ativa quando o usuário diz "me avisa quando passar", "resolve os comentários",
  "cuida do PR pra mim", "fica de olho no CI", ou qualquer variação de acompanhar um PR.
  A skill mantém um loop contínuo verificando: CI (GitHub Actions), quality gate (ratchet
  + SonarCloud), Copilot Review, e revisores humanos — corrigindo e pushando quando
  possível, escalando para o usuário apenas quando encontra um bloqueador que não
  consegue resolver sozinho.
---

# Babysit PR

Loop contínuo até um desfecho terminal: PR mergeado, fechado, ou bloqueador humano.

## Início rápido

1. Identifique o PR (número ou URL) na mensagem do usuário.
2. Se não foi especificado, use `gh pr list` para mostrar os PRs abertos.
3. Rode `node scripts/babysit-loop.cjs --pr N --once --json`.
4. Se precisar de detalhe bruto, rode `pr-snapshot.cjs` e `ci-diagnose.cjs`.
5. Confie em `snapshot.merge.ready`; nunca declare PR pronto quando esse campo for `false`.
6. Leia `references/fix-playbook.md` apenas para a action retornada.
7. **Entre no loop imediatamente** — não peça confirmação.

## O loop

```
loop até desfecho terminal:
  ciclo = babysit-loop.cjs       # snapshot + diagnose
  ações = ciclo.actions          # classifica falhas determinísticas
  fix(ações)                     # corrige código, commit, push
  wait_ci()                      # polling até próximo ciclo
```

## Snapshot — fonte de verdade do ciclo

Prefira sempre o script:

```bash
node scripts/babysit-loop.cjs --pr $PR_NUMBER --once --json
```

Para artefatos persistidos:

```bash
node scripts/pr-snapshot.cjs --pr $PR_NUMBER --json --output .quality-gate/reports/pr-snapshot.json
```

Se `latestRun.id` existir e `ci.overall == "failure"`:

```bash
node scripts/ci-diagnose.cjs --snapshot .quality-gate/reports/pr-snapshot.json --json --output .quality-gate/reports/ci-diagnose.json
```

Use os comandos manuais de `references/pr-watcher.md` só quando o script falhar.

```json
{
  "pr": {
    "number": 42,
    "branch": "feature/codex-xyz",
    "mergeable": "MERGEABLE",
    "mergeStateStatus": "BLOCKED"
  },
  "ci": {
    "overall": "failure",
    "jobs": {
      "security": "success",
      "lint": "failure",
      "test": "success",
      "sonar": "failure",
      "report": "success"
    }
  },
  "merge": {
    "state": "BLOCKED",
    "ready": false,
    "blockers": [
      { "type": "blocked_by_policy", "action": "blocked_by_policy", "message": "GitHub mergeStateStatus=BLOCKED" }
    ],
    "advisories": []
  },
  "checks": {
    "required": [],
    "advisory": [{ "name": "SonarCloud Code Analysis", "conclusion": "failure" }],
    "unknown": []
  },
  "reviewThreads": {
    "status": "known",
    "unresolved": []
  },
  "copilotBlockers": ["src/auth.ts:42 - sem tratamento de erro"],
  "humanBlockers": [],
  "latestRun": { "id": 123456789 },
  "artifacts": [{ "name": "coverage-report" }],
  "actions": ["fix_lint", "diagnose_sonar"]
}
```

O campo `actions` dita as correções deste ciclo.

## Tabela de actions

| Action | Quando | O que fazer |
|--------|--------|-------------|
| `fix_lint` | ESLint falhou | `npx eslint src --fix` + corrigir manualmente o que sobrar |
| `fix_security` | npm audit critical | `npm audit fix`, testar, verificar breaking changes |
| `fix_ratchet` | coverage regrediu | ver arquivos com menor % em coverage-summary.json, adicionar testes |
| `diagnose_ci` | job genérico falhou | ler logs do job, classificar (código vs infra), corrigir |
| `process_copilot` | Copilot comentou "Bloqueador:" | implementar correção sugerida, um commit por comentário |
| `process_human` | revisor pediu mudança | implementar, manter o reviewer informado |
| `diagnose_sonar` | SonarCloud falhou | ler comentário do sonarcloud[bot] no PR, corrigir issues |
| `diagnose_docker` | Docker image gate falhou | ler `.quality-gate/reports/docker-image-doctor.json` ou logs do job |
| `fix_required_check` | Check obrigatorio falhou | rodar `ci-diagnose`, identificar job e corrigir causa |
| `diagnose_optional_check` | Check advisory falhou | registrar risco; corrigir se barato, mas nao tratar como blocker automatico |
| `resolve_review_threads` | GraphQL encontrou review thread unresolved | resolver comentario ou escalar decisao humana |
| `verify_review_threads_manual` | GraphQL nao confirmou threads | parar e pedir verificacao/permissao; nao declarar pronto |
| `blocked_by_policy` | GitHub merge state/policy bloqueia merge | inspecionar branch protection, required checks e permissao |
| `sync_branch` | Branch atrasada | atualizar branch do PR ou pedir acao se policy exigir |
| `rerun_flaky` | falha de infra/timeout | `gh run rerun $RUN_ID --failed` (máx 3x) |
| `wait_ci` | CI rodando | aguardar com polling a cada 30s |
| `ready` | tudo verde e sem blockers | reportar PR pronto |
| `ready_with_advisory` | required verde e merge liberado, mas advisory falhou | reportar pronto com risco explicito |
| `escalate` | bloqueador ambíguo | reportar ao usuário com contexto completo |

## Regras de commit/push

- Commit e push após **cada** correção, nunca acumule vários fixes sem push.
- Formato: `fix(babysit): [tipo] [descrição curta]`
  - Exemplos: `fix(babysit): eslint no-unused-vars em useAuth.ts`
  - `fix(babysit): cobertura de branches em userReducer.test.ts`
  - `fix(babysit): sonar code smell em api/client.ts`
- Nunca force-push. Sempre commits normais sobre a branch do PR.
- Após push, aguardar CI completar antes do próximo snapshot.

## Onde o agente encontra os artefatos de erro

O CI faz upload de dois artefatos que o agente deve ler para diagnóstico:

**coverage-report** — gerado pelo job `test`:
- `coverage/coverage-summary.json` — métricas por arquivo (ver quais regrediram)
- `coverage/lcov.info` — para o SonarCloud
- `coverage/eslint-report.json` — violations do ESLint em JSON

```bash
# Baixar artefatos do run mais recente
gh run download $(gh run list --branch $(gh pr view $PR --json headRefName -q .headRefName) \
  --json databaseId -q '.[0].databaseId') --dir /tmp/ci-artifacts
```

**Sticky comment no PR** — sempre atualizado pelo job `report`:
- Mostra `Can merge`, `Next action`, required checks e coverage resumido.
- Usa `.quality-gate/reports/pr-snapshot.json` quando o workflow conseguiu gerar snapshot.
- Se o snapshot nao existir, usa linguagem conservadora: checks verdes nao significam PR pronto.
- Detalhes completos ficam no `GITHUB_STEP_SUMMARY`; blockers e menor coverage podem aparecer como annotations do Actions.
- O loop da skill deve continuar confiando em `snapshot.merge.ready`, nao no texto do comentario.

## Desfechos terminais

| Condição | O que fazer |
|----------|-------------|
| PR mergeado ou fechado | Encerrar, reportar resumo ao usuário |
| `snapshot.merge.ready == true` e action `ready` | Reportar "PR pronto" e parar o loop |
| `snapshot.merge.ready == true` e action `ready_with_advisory` | Reportar pronto com advisory e parar o loop |
| `verify_review_threads_manual` | Parar; pedir verificacao/permissao. Nao dizer pronto |
| Conflito de merge complexo | Escalate — decisão humana de arquitetura |
| 3 re-runs sem sucesso no mesmo job | Escalate — provavelmente infra |
| 10 ciclos sem progresso | Escalate com histórico de tentativas |
| Comentário humano pede decisão de design | Escalate imediato |

## Escalate — template

Ao escalar, inclua sempre:

```
🚨 Babysit PR #[N] — preciso da sua atenção

O que foi feito nesta sessão:
- [lista de commits feitos]

O que está bloqueando:
- [erro exato]

Hipótese do motivo:
- [análise]

O que você precisa decidir/fazer:
- [ação específica necessária]
```

## Referências

- `references/pr-watcher.md` — todos os comandos `gh` para snapshot e polling
- `references/fix-playbook.md` — receitas detalhadas de correção por tipo de falha
