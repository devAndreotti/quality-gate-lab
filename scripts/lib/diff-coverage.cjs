// diff-coverage.cjs — calcula cobertura sobre linhas alteradas no git diff
const fs = require('node:fs');
const path = require('node:path');

function parseDiffLineNumbers(diffText) {
  const fileChanges = new Map();
  let currentFile = null;
  let currentLineNumber = 0;

  for (const line of String(diffText || '').split(/\r?\n/)) {
    const diffHeader = line.match(/^\+\+\+ b\/(.+)$/);
    if (diffHeader) {
      currentFile = diffHeader[1].replace(/\\/g, '/');
      if (!fileChanges.has(currentFile)) fileChanges.set(currentFile, new Set());
      continue;
    }

    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      currentLineNumber = parseInt(hunk[1], 10);
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (currentFile) fileChanges.get(currentFile).add(currentLineNumber);
      currentLineNumber++;
    } else if (!line.startsWith('-')) {
      currentLineNumber++;
    }
  }

  return fileChanges;
}

function parseLcovCoverageMap(lcovText) {
  const coverageMap = new Map();
  let currentFile = null;

  for (const line of String(lcovText || '').split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      currentFile = line.slice(3).trim().replace(/\\/g, '/');
      if (!coverageMap.has(currentFile)) coverageMap.set(currentFile, new Map());
      continue;
    }
    if (line.startsWith('DA:')) {
      const [lineNum, hits] = line.slice(3).split(',').map(Number);
      if (currentFile) coverageMap.get(currentFile).set(lineNum, hits);
    }
  }

  return coverageMap;
}

function calculateDiffCoverage({ diffText, lcovText, minDiffCoverage = 80 }) {
  const diffMap = parseDiffLineNumbers(diffText);
  const lcovMap = parseLcovCoverageMap(lcovText);

  let totalChangedExecutableLines = 0;
  let coveredChangedLines = 0;
  const details = [];

  for (const [diffFile, changedLines] of diffMap.entries()) {
    // Tenta casar nome de arquivo exato ou sufixo
    let fileCoverage = null;
    for (const [lcovFile, hitsMap] of lcovMap.entries()) {
      if (lcovFile === diffFile || lcovFile.endsWith(diffFile) || diffFile.endsWith(lcovFile)) {
        fileCoverage = hitsMap;
        break;
      }
    }

    if (!fileCoverage) continue;

    for (const lineNum of changedLines) {
      if (fileCoverage.has(lineNum)) {
        totalChangedExecutableLines++;
        const hits = fileCoverage.get(lineNum);
        if (hits > 0) {
          coveredChangedLines++;
        } else {
          details.push({ file: diffFile, line: lineNum, status: 'uncovered' });
        }
      }
    }
  }

  const pct = totalChangedExecutableLines === 0
    ? 100
    : Number(((coveredChangedLines / totalChangedExecutableLines) * 100).toFixed(2));

  return {
    pct,
    totalLines: totalChangedExecutableLines,
    coveredLines: coveredChangedLines,
    passed: pct >= minDiffCoverage,
    minDiffCoverage,
    uncovered: details,
  };
}

// Arquivos de código de produção que entram no gate. Testes e artefatos ficam de fora.
const GATED_SOURCE_PATTERN = /\.(?:c|m)?js$|\.(?:ts|tsx|jsx)$/;
const EXCLUDED_PATH_PATTERN = /(?:^|\/)(?:node_modules|coverage|dist|build)\/|\.(?:test|spec)\.[a-zA-Z0-9]+$/;

function isGatedSource(file) {
  return GATED_SOURCE_PATTERN.test(file) && !EXCLUDED_PATH_PATTERN.test(file);
}

// Como parseDiffLineNumbers, mas guarda também o conteúdo de cada linha adicionada
// para ignorar linhas em branco (que não são executáveis).
function parseAddedLines(diffText) {
  const fileChanges = new Map();
  let currentFile = null;
  let currentLineNumber = 0;

  for (const line of String(diffText || '').split(/\r?\n/)) {
    const diffHeader = line.match(/^\+\+\+ b\/(.+)$/);
    if (diffHeader) {
      currentFile = diffHeader[1].replace(/\\/g, '/');
      if (!fileChanges.has(currentFile)) fileChanges.set(currentFile, new Map());
      continue;
    }

    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      currentLineNumber = parseInt(hunk[1], 10);
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (currentFile) fileChanges.get(currentFile).set(currentLineNumber, line.slice(1));
      currentLineNumber++;
    } else if (!line.startsWith('-')) {
      currentLineNumber++;
    }
  }

  return fileChanges;
}

// Casa caminho do diff com caminho do LCOV por limite de diretório, evitando
// que "x.cjs" case com "scripts/x.cjs" por acidente de sufixo.
function findCoverageForFile(lcovMap, diffFile) {
  for (const [lcovFile, hitsMap] of lcovMap.entries()) {
    if (lcovFile === diffFile || lcovFile.endsWith('/' + diffFile) || diffFile.endsWith('/' + lcovFile)) {
      return hitsMap;
    }
  }
  return null;
}

// Avalia o gate de diff coverage.
// - Linha adicionada em arquivo de produção e executável: precisa de hits > 0.
// - Arquivo de produção alterado que não aparece no LCOV: nenhum teste o carregou,
//   então todas as linhas não em branco adicionadas contam como descobertas.
function evaluateDiffCoverage({ diffText, lcovText, minDiffCoverage = 90 }) {
  const addedLines = parseAddedLines(diffText);
  const lcovMap = parseLcovCoverageMap(lcovText);

  let totalLines = 0;
  let coveredLines = 0;
  const uncovered = [];
  const untestedFiles = [];

  for (const [file, lines] of addedLines.entries()) {
    if (!isGatedSource(file)) continue;

    const fileCoverage = findCoverageForFile(lcovMap, file);
    if (!fileCoverage) {
      const meaningful = [...lines.entries()].filter(([, content]) => content.trim() !== '');
      if (meaningful.length === 0) continue;
      untestedFiles.push(file);
      totalLines += meaningful.length;
      for (const [lineNum] of meaningful) uncovered.push({ file, line: lineNum, status: 'no-coverage-record' });
      continue;
    }

    for (const lineNum of lines.keys()) {
      if (!fileCoverage.has(lineNum)) continue;
      totalLines++;
      if (fileCoverage.get(lineNum) > 0) {
        coveredLines++;
      } else {
        uncovered.push({ file, line: lineNum, status: 'uncovered' });
      }
    }
  }

  const pct = totalLines === 0
    ? 100
    : Number(((coveredLines / totalLines) * 100).toFixed(2));

  return {
    pct,
    totalLines,
    coveredLines,
    passed: pct >= minDiffCoverage,
    minDiffCoverage,
    untestedFiles,
    uncovered,
  };
}

module.exports = {
  calculateDiffCoverage,
  evaluateDiffCoverage,
  isGatedSource,
  parseAddedLines,
  parseDiffLineNumbers,
  parseLcovCoverageMap,
};