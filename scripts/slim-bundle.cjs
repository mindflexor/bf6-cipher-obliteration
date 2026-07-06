const fs = require("fs");
const path = require("path");

const bundlePath = path.join(process.cwd(), "dist", "bundle.ts");

if (!fs.existsSync(bundlePath)) {
  console.error(`[slim-bundle] Missing bundle file: ${bundlePath}`);
  process.exit(1);
}

const original = fs.readFileSync(bundlePath, "utf8");

function stripCommentsOutsideStrings(input) {
  let out = "";
  let i = 0;
  let state = "code";
  let templateBraceDepth = 0;
  let keptTsNoCheck = false;

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    if (state === "lineComment") {
      if (ch === "\n") {
        out += "\n";
        state = "code";
      }
      i += 1;
      continue;
    }

    if (state === "blockComment") {
      if (ch === "*" && next === "/") {
        i += 2;
        state = "code";
        continue;
      }

      if (ch === "\n") {
        out += "\n";
      }

      i += 1;
      continue;
    }

    if (state === "singleQuote") {
      out += ch;

      if (ch === "\\") {
        if (i + 1 < input.length) {
          out += input[i + 1];
          i += 2;
          continue;
        }
      }

      if (ch === "'") {
        state = "code";
      }

      i += 1;
      continue;
    }

    if (state === "doubleQuote") {
      out += ch;

      if (ch === "\\") {
        if (i + 1 < input.length) {
          out += input[i + 1];
          i += 2;
          continue;
        }
      }

      if (ch === '"') {
        state = "code";
      }

      i += 1;
      continue;
    }

    if (state === "template") {
      out += ch;

      if (ch === "\\") {
        if (i + 1 < input.length) {
          out += input[i + 1];
          i += 2;
          continue;
        }
      }

      if (ch === "`" && templateBraceDepth === 0) {
        state = "code";
      } else if (ch === "$" && next === "{") {
        out += next;
        i += 2;
        templateBraceDepth += 1;
        state = "templateExpr";
        continue;
      }

      i += 1;
      continue;
    }

    if (state === "templateExpr") {
      if (ch === "/" && next === "/") {
        state = "templateExprLineComment";
        i += 2;
        continue;
      }

      if (ch === "/" && next === "*") {
        state = "templateExprBlockComment";
        i += 2;
        continue;
      }

      out += ch;

      if (ch === "'") {
        state = "templateExprSingleQuote";
      } else if (ch === '"') {
        state = "templateExprDoubleQuote";
      } else if (ch === "`") {
        state = "template";
      } else if (ch === "{") {
        templateBraceDepth += 1;
      } else if (ch === "}") {
        templateBraceDepth -= 1;
        if (templateBraceDepth <= 0) {
          templateBraceDepth = 0;
          state = "template";
        }
      }

      i += 1;
      continue;
    }

    if (state === "templateExprLineComment") {
      if (ch === "\n") {
        out += "\n";
        state = "templateExpr";
      }
      i += 1;
      continue;
    }

    if (state === "templateExprBlockComment") {
      if (ch === "*" && next === "/") {
        i += 2;
        state = "templateExpr";
        continue;
      }

      if (ch === "\n") {
        out += "\n";
      }

      i += 1;
      continue;
    }

    if (state === "templateExprSingleQuote") {
      out += ch;

      if (ch === "\\") {
        if (i + 1 < input.length) {
          out += input[i + 1];
          i += 2;
          continue;
        }
      }

      if (ch === "'") {
        state = "templateExpr";
      }

      i += 1;
      continue;
    }

    if (state === "templateExprDoubleQuote") {
      out += ch;

      if (ch === "\\") {
        if (i + 1 < input.length) {
          out += input[i + 1];
          i += 2;
          continue;
        }
      }

      if (ch === '"') {
        state = "templateExpr";
      }

      i += 1;
      continue;
    }

    // Normal code state.
    if (ch === "/" && next === "/") {
      const lineEnd = input.indexOf("\n", i);
      const commentLine = input.slice(i, lineEnd === -1 ? input.length : lineEnd);

      // Keep exactly one ts-nocheck comment for Portal/devkit compatibility.
      if (!keptTsNoCheck && commentLine.includes("@ts-nocheck")) {
        out += "// @ts-nocheck";
        keptTsNoCheck = true;
      }

      state = "lineComment";
      i += 2;
      continue;
    }

    if (ch === "/" && next === "*") {
      state = "blockComment";
      i += 2;
      continue;
    }

    if (ch === "'") {
      state = "singleQuote";
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      state = "doubleQuote";
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "`") {
      state = "template";
      out += ch;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  // Trim whitespace-only lines and collapse excessive blank lines.
  out = out
    .split("\n")
    .map((line) => (line.trim().length === 0 ? "" : line.replace(/[ \t]+$/g, "")))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  if (!out.startsWith("// @ts-nocheck")) {
    out = `// @ts-nocheck\n${out}`;
  }

  return out;
}

const slimmed = stripCommentsOutsideStrings(original);

fs.writeFileSync(bundlePath, slimmed, "utf8");

const savedBytes = Buffer.byteLength(original, "utf8") - Buffer.byteLength(slimmed, "utf8");

console.log(`[slim-bundle] ${Buffer.byteLength(original, "utf8")} -> ${Buffer.byteLength(slimmed, "utf8")} bytes`);
console.log(`[slim-bundle] Saved ${savedBytes} bytes`);