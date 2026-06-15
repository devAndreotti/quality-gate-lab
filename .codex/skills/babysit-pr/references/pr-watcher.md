# PR Watcher — scripts primeiro, comandos gh como fallback

Todos os comandos assumem working directory na raiz do repo.

## Snapshot determinístico

Use isto antes de comandos manuais:

```bash
node scripts/babysit-loop.cjs --pr $PR_NUMBER --once --json
```

Se precisar gravar artefatos:

```bash
node scripts/pr-snapshot.cjs --pr $PR_NUMBER --json --output .quality-gate/reports/pr-snapshot.json
```

Diagnóstico de CI:

```bash
node scripts/ci-diagnose.cjs --snapshot .quality-gate/reports/pr-snapshot.json --json --output .quality-gate/reports/ci-diagnose.json
```

Os scripts tentam `gh` primeiro e caem para API GitHub quando possível.

## Fallback manual com gh

## Snapshot completo do PR

```bash
# Estado geral do PR (mergeabilidade, branch, título)
gh pr view $PR_NUMBER --json number,title,state,mergeable,headRefName,baseRefName

# Status de todos os checks (CI jobs)
gh pr checks $PR_NUMBER --json name,state,bucket,link,startedAt,completedAt,workflow

# Comentários de review (inclui Copilot e humanos)
gh pr view $PR_NUMBER --json reviews,comments,reviewRequests

# Ver comentários inline (review threads)
gh api repos/$REPO/pulls/$PR_NUMBER/reviews
gh api repos/$REPO/pulls/$PR_NUMBER/comments
```

## Filtrar comentários não resolvidos

```bash
# Comentários do Copilot ainda não resolvidos
gh api repos/$REPO/pulls/$PR_NUMBER/comments \
  --jq '[.[] | select(.user.login == "copilot[bot]") | select(.position != null)]'

# Todos os comentários de review pendentes (não dismissed, não resolved)
gh api repos/$REPO/pulls/PR_NUMBER/reviews \
  --jq '[.[] | select(.state == "CHANGES_REQUESTED")]'
```

## Ler logs de um job falho

```bash
# Listar runs do workflow no PR
gh run list --branch $(gh pr view $PR_NUMBER --json headRefName -q .headRefName)

# Baixar logs do run mais recente
gh run view $RUN_ID --log-failed

# Alternativa: via API (retorna URL do log)
gh api repos/$REPO/actions/runs/$RUN_ID/jobs \
  --jq '.jobs[] | select(.conclusion == "failure") | {name, steps: [.steps[] | select(.conclusion == "failure")]}'
```

## Polling — aguardar CI completar

```bash
# Aguarda até todos os checks terminarem (sucesso ou falha)
gh pr checks $PR_NUMBER --watch

# Alternativa com timeout manual (loop a cada 30s por até 10min)
for i in $(seq 1 20); do
  STATUS=$(gh pr checks $PR_NUMBER --json state -q '[.[] | .state] | unique | @csv')
  echo "Ciclo $i: $STATUS"
  if [[ "$STATUS" != *"null"* ]]; then break; fi
  sleep 30
done
```

## Verificar artefatos do CI (coverage, SonarCloud, report)

```bash
# Listar artefatos disponíveis no run mais recente
gh run view $RUN_ID --json artifacts

# Baixar artefato de coverage
gh run download $RUN_ID -n coverage-report --dir /tmp/coverage

# O job PR report grava step summary e annotations.
# Use o link do run no sticky comment para abrir o summary completo quando necessario.
node scripts/pr-snapshot.cjs --pr $PR_NUMBER --json --output .quality-gate/reports/pr-snapshot.json
```

## Commit e push após correção

```bash
# Staged e commit
git add -A
git commit -m "fix: $TIPO $DESCRICAO (babysit-pr)"

# Push na branch do PR (sem force)
git push origin HEAD
```

## Verificar status de merge

```bash
gh pr view $PR_NUMBER --json mergeable,mergeStateStatus \
  --jq '{mergeable, mergeStateStatus}'
# mergeable: MERGEABLE | CONFLICTING | UNKNOWN
# mergeStateStatus: CLEAN | BLOCKED | BEHIND | DIRTY
```
