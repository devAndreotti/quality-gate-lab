# Fix Playbook — correções por tipo de falha

Para cada tipo de falha, o playbook descreve: como diagnosticar, como corrigir, e como validar.

---

## 1. Ratchet falhou (coverage regrediu)

**Diagnóstico**
```bash
# Ver quais métricas regrediram no step summary
gh run view $RUN_ID --log | grep -A 20 "Quality Gate — Ratchet"

# Ver coverage atual vs baseline
cat coverage/coverage-summary.json | node -e "
  const d=JSON.parse(require('fs').readFileSync('/dev/stdin'));
  const t=d.total;
  console.log('lines',t.lines.pct,'statements',t.statements.pct,'functions',t.functions.pct,'branches',t.branches.pct);
"

# Ver arquivos com menor coverage
cat coverage/coverage-summary.json | node -e "
  const d=JSON.parse(require('fs').readFileSync('/dev/stdin'));
  Object.entries(d)
    .filter(([k])=>k!=='total')
    .sort((a,b)=>a[1].lines.pct-b[1].lines.pct)
    .slice(0,10)
    .forEach(([f,m])=>console.log(m.lines.pct.toFixed(1)+'%',f));
"
```

**Correção**
1. Identifique os arquivos com menor coverage no diff do PR.
2. Adicione testes para os caminhos não cobertos (especialmente `branches`).
3. Padrão de arquivo de teste: `src/caminho/arquivo.test.ts`.
4. Foque em: funções exportadas, branches de erro, casos edge.

**Validação**
```bash
npm run test:coverage:ci && node scripts/quality-gate.js check
```

---

## 2. ESLint falhou

**Diagnóstico**
```bash
npm run lint 2>&1 | head -50
# ou com saída JSON para parsear:
npx eslint src --format json 2>/dev/null | node -e "
  const r=JSON.parse(require('fs').readFileSync('/dev/stdin'));
  r.filter(f=>f.errorCount>0).forEach(f=>console.log(f.filePath,f.messages.map(m=>m.message)));
"
```

**Correção**
```bash
# Auto-fix o que for possível
npx eslint src --fix

# Para erros que não têm auto-fix, edite manualmente seguindo a regra reportada
```

**Regras comuns e como corrigir**

| Regra | Causa | Correção |
|-------|-------|----------|
| `no-unused-vars` | Variável declarada e não usada | Remover ou usar |
| `react-hooks/exhaustive-deps` | Dep faltando no useEffect | Adicionar dep ou usar `useCallback` |
| `@typescript-eslint/no-explicit-any` | `any` explícito | Tipar corretamente ou usar `unknown` |
| `no-console` | `console.log` em prod | Remover ou mover para teste |

---

## 3. SonarCloud — Quality Gate falhou

**Diagnóstico**

O SonarCloud posta um comentário no PR com o detalhamento. Leia:
```bash
# Comentários do sonarcloud[bot] no PR
gh api repos/$REPO/pulls/$PR_NUMBER/comments \
  --jq '[.[] | select(.user.login == "sonarcloud[bot]")] | last | .body'
```

Ou acesse a URL do SonarCloud que aparece no check do PR.

**Tipos comuns e correções**

| Tipo | O que é | Correção |
|------|---------|----------|
| Code smell | Código difícil de manter | Refatorar conforme sugestão |
| Bug | Erro lógico detectado estaticamente | Corrigir a lógica |
| Security hotspot | Risco de segurança potencial | Revisar e marcar como "acknowledged" ou corrigir |
| Duplicação acima do limite | Código repetido | Extrair para função/hook compartilhado |
| Coverage abaixo do gate | < threshold definido | Adicionar testes (ver seção 1) |

---

## 4. Copilot Review — comentários com "Bloqueador:"

**Diagnóstico**
```bash
# Ler comentários do Copilot no PR
gh api repos/$REPO/pulls/$PR_NUMBER/comments \
  --jq '[.[] | select(.user.login == "copilot[bot]") | {path: .path, line: .line, body: .body}]'
```

**Processo**
1. Leia cada comentário com "Bloqueador:" no corpo.
2. Identifique o arquivo e linha afetados.
3. Implemente a correção sugerida (ou equivalente se a sugestão não for diretamente aplicável).
4. Para cada comentário resolvido, adicione um commit separado com mensagem descritiva.
5. Não resolva conversas manualmente — o Copilot re-avaliará no próximo push.

**Comentários com "Sugestão:"** são opcionais — aplique se fizer sentido, ignore se aumentar o escopo.

---

## 5. npm audit — vulnerabilidade crítica

**Diagnóstico**
```bash
npm audit --audit-level=critical --json | node -e "
  const r=JSON.parse(require('fs').readFileSync('/dev/stdin'));
  Object.values(r.vulnerabilities)
    .filter(v=>v.severity==='critical')
    .forEach(v=>console.log(v.name, v.fixAvailable));
"
```

**Correção**
```bash
# Tentar auto-fix
npm audit fix

# Se houver breaking changes
npm audit fix --force
# ⚠️ Após --force, rode os testes para verificar que nada quebrou
npm run test:coverage:ci
```

Se não houver fix disponível → escalate imediato. Não é possível corrigir automaticamente.

---

## 6. Falha de infra (runner problema, timeout de rede)

**Diagnóstico**: o log do job mostra erro de rede, OOM, ou timeout sem relação com o código.

**Ação**: re-trigger do CI sem mudança de código:
```bash
gh run rerun $RUN_ID --failed
```

Máximo de 3 re-triggers para o mesmo run. Se continuar falhando → escalate.

---

## 7. Docker image gate falhou

**Diagnóstico**
```bash
node scripts/docker-gate.cjs --project . --json
cat .quality-gate/reports/docker-image-doctor.json
```

**Correção**
1. Se `fallback == "static-advisory"`, corrija primeiro achados estáticos: `.dockerignore`, `FROM :latest`, falta de `USER`, segredos em Dockerfile, `privileged: true`.
2. Se Docker Image Doctor local rodou, siga `doctorResult.findings`.
3. Revalide sem modo interativo.

**Validação**
```bash
node scripts/docker-gate.cjs --project . --json
```

---

## 8. Conflito de merge

**Diagnóstico**
```bash
gh pr view $PR_NUMBER --json mergeable -q .mergeable
# retorna: CONFLICTING
```

**Correção**
```bash
# Rebase na base branch
git fetch origin
git rebase origin/main

# Resolver conflitos manualmente se forem simples (imports, versão de lock file)
# Se o conflito for em lógica de negócio → escalate
```

Conflitos em `package-lock.json`:
```bash
# Deletar e regenerar
rm package-lock.json
npm install
git add package-lock.json
git commit -m "fix: regenerate package-lock after rebase (babysit-pr)"
```
