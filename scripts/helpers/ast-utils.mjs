import fs from "node:fs";

export function readSource(file) {
  return fs.readFileSync(file, "utf8");
}

export function getLines(source) {
  return source.split(/\r?\n/);
}

export function lineCount(source) {
  return getLines(source).length;
}

export function contains(source, text) {
  return source.includes(text);
}

export function containsAny(source, values) {
  return values.some(value => source.includes(value));
}

export function countOccurrences(source, value) {
  return source.split(value).length - 1;
}