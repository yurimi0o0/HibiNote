#!/usr/bin/env node
// セットアップ時に一度だけ実行: js/config.js の PASSCODE を新しいランダム8桁数字に差し替える。
// 発行されたコードは管理者がチームメンバーに個別共有すること(サイト上には表示されない)。
import { randomInt } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, "js", "config.js");

function isTooSimple(code) {
  const digits = code.split("");
  const allSame = digits.every((d) => d === digits[0]);
  const sorted = [...digits].sort().join("");
  const isAscending = digits.join("") === sorted;
  const isDescending = digits.join("") === [...sorted].reverse().join("");
  return allSame || isAscending || isDescending;
}

function generatePasscode() {
  let code;
  do {
    code = Array.from({ length: 8 }, () => randomInt(0, 10)).join("");
  } while (isTooSimple(code));
  return code;
}

const passcode = generatePasscode();
const original = readFileSync(configPath, "utf8");
const updated = original.replace(
  /export const PASSCODE = ".*";/,
  `export const PASSCODE = "${passcode}";`
);

if (updated === original) {
  console.error("PASSCODE の置換に失敗しました。js/config.js の内容を確認してください。");
  process.exit(1);
}

writeFileSync(configPath, updated);
console.log("新しい合言葉を発行しました:");
console.log(passcode);
console.log("この合言葉をチームメンバーに個別共有してください(サイト上には表示されません)。");
