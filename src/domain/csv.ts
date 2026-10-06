/** Lê CSV com aspas e detecta o separador (`,`, `;` ou tab), como o Excel e o Google Sheets exportam. */
export function parseCsv(text: string): string[][] {
  const input = text.replace(/^﻿/, "");
  const firstLine = input.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [",", ";", "\t"].reduce((best, candidate) =>
    count(firstLine, candidate) > count(firstLine, best) ? candidate : best,
  );

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((value) => value.trim() !== ""));
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

export interface AssetRow {
  asset_short_id: string;
  serial: string;
}

export interface ParsedAssets {
  rows: AssetRow[];
  /** Linhas sem asset_short_id ou sem serial, que não são enviadas. */
  invalid: number;
  /** Mensagem quando o arquivo não tem o formato esperado. */
  error?: string;
}

const normalizeHeader = (value: string) => value.trim().toLowerCase().replace(/\s+/g, "_");

/** Extrai as colunas `asset_short_id` e `serial` (em qualquer ordem) de um CSV exportado da planilha. */
export function parseAssetsCsv(text: string): ParsedAssets {
  const table = parseCsv(text);
  const header = table[0]?.map(normalizeHeader) ?? [];
  const idCol = header.indexOf("asset_short_id");
  const serialCol = header.indexOf("serial");
  if (idCol < 0 || serialCol < 0) {
    return { rows: [], invalid: 0, error: "O CSV precisa ter as colunas asset_short_id e serial na primeira linha." };
  }

  const rows: AssetRow[] = [];
  let invalid = 0;
  for (const line of table.slice(1)) {
    const asset_short_id = (line[idCol] ?? "").trim();
    const serial = (line[serialCol] ?? "").trim();
    if (asset_short_id && serial) rows.push({ asset_short_id, serial });
    else invalid++;
  }
  return { rows, invalid };
}
