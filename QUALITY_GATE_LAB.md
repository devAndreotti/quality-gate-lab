# Quality Gate Lab

Este repo existe para testar o que e deterministico no Quality Gate e o que e decisao de IA/skill.

## Separacao

| Camada | Faz |
|---|---|
| Quality Gate | Instala policy/workflow, roda CI, valida localmente, calcula ratchet, gera snapshot, comenta PR. |
| babysit-pr | Opera um PR aberto: le snapshot/actions, corrige falhas tecnicas, commit/push, espera CI e escala blockers humanos. |
| Copilot Review | Opcional. Se nao existir credito/plano/review, Quality Gate continua funcionando. |
| SonarCloud | Opcional/advisory por padrao. Sem token/config, deve ser pulado ou removido com `--skip-sonar`. |

## Quem decide o que

Quality Gate decide por fatos deterministas:

- comandos locais e CI (`npm ci`, `npm test`, `npm run lint`, `npm run build`, `npm audit`);
- cobertura atual contra baseline/ratchet;
- checks obrigatorios em `.quality-gate/policy.json`;
- Docker gate quando existem `Dockerfile`, `docker-compose.yml` ou compose equivalente;
- snapshot de PR: checks, review threads, mergeability, labels e blockers.

IA nao substitui gate:

- Copilot Review pode sugerir comentario, mas nao vira requisito se nao existir review.
- `babysit-pr` usa snapshot e GitHub como entrada; ele corrige, commita, espera CI e escala blocker.
- PR so fica pronto quando `snapshot.merge.ready === true`.
- Se permissao/API nao permitir ler review threads, fluxo deve marcar acao manual, nao inventar "pronto".

## Fallback esperado

- Sem Copilot Review: nao ha comentarios do Copilot para processar; `babysit-pr` segue por CI, snapshot e reviewers humanos.
- Sem credito Copilot: mesmo caso acima. Nao ha review Copilot; Quality Gate ainda roda seguranca/lint/test/coverage/Docker/snapshot.
- Sem SonarCloud/SonarQube: Sonar nao deve bloquear se nao estiver em `requiredChecks`; use `--skip-sonar` em bootstrap/configure quando projeto nao usa Sonar.
- Sem Docker: `docker-gate.cjs` retorna `skipped`.
- Sem permissao para review threads: snapshot deve usar action `verify_review_threads_manual`; nao declarar pronto.
- Email do GitHub: layout do email nao e controlado pelo Quality Gate. O que da para customizar e o corpo do comentario/summary no PR; GitHub decide renderizacao do email.

## Ferramentas usadas

| Area | Ferramenta |
|---|---|
| Node install/test/lint/build/audit | `npm ci`, `npm run test --if-present`, `npm run lint --if-present`, `npm run build --if-present`, `npm audit --audit-level=moderate` |
| Coverage JS | `node --test --experimental-test-coverage` neste lab |
| Quality Gate core | `scripts/quality-gate.js`, `scripts/doctor.cjs`, `.quality-gate/policy.json` |
| PR snapshot | `scripts/pr-snapshot.cjs`, GitHub CLI/API |
| PR comment | `scripts/pr-comment.js`, GitHub Actions summary/comment |
| Babysit | `scripts/babysit-loop.cjs` + skill `.codex/skills/babysit-pr` |
| Docker | `scripts/docker-gate.cjs`, so quando Docker files existem |
| Sonar | SonarCloud/SonarQube somente se configurado e exigido |

## Comandos de prova

```powershell
npm test
npm run lint
npm run build
node scripts/quality-gate.js init
node scripts/quality-gate.js check
node scripts/doctor.cjs --dry-run
node scripts/local-validate.cjs --project . --profile pr --json
node scripts/docker-gate.cjs --project . --json
```

## PR real

Depois de abrir PR:

```powershell
node scripts/pr-snapshot.cjs --pr <N> --json --output .quality-gate/reports/pr-snapshot.json
node scripts/babysit-loop.cjs --pr <N> --once --json
```

Regra: pronto so se `snapshot.merge.ready === true`.

## Resultado observado neste lab

Validado em 2026-06-15:

- `npm test`: passou, 4 testes, coverage 100%.
- `npm run lint`: passou.
- `npm run build`: passou.
- `node scripts/quality-gate.js init`: atualizou baseline para 100%.
- `node scripts/quality-gate.js check`: passou.
- `node scripts/doctor.cjs --dry-run`: passou, Sonar desativado na policy.
- `node scripts/doctor.cjs --release`: passou.
- `node scripts/docker-gate.cjs --project . --json`: passou com `skipped`, pois lab nao tem Docker files.
- `node scripts/local-validate.cjs --project . --profile pr --json`: passou, incluindo `npm ci`, test, lint, build, audit, doctor e git checks.

Gotcha achado: no Windows, `spawnSync('npm.cmd')` falhava com `EINVAL`. Fix aplicado no Quality Gate fonte e copiado para este lab: shims `npm`/`uv`/`uvx` rodam via `cmd.exe /d /s /c`.
