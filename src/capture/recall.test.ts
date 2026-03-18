import { describe, test, expect } from "bun:test";
import { extractErrorSignature } from "./recall.js";

describe("extractErrorSignature", () => {
  test("returns null for empty output", () => {
    expect(extractErrorSignature("")).toBeNull();
    expect(extractErrorSignature("ok")).toBeNull();
  });

  test("extracts Python errors", () => {
    const output = `Traceback (most recent call last):
  File "main.py", line 10, in <module>
    import foo
ModuleNotFoundError: No module named 'foo'`;
    expect(extractErrorSignature(output)).toBe("ModuleNotFoundError: No module named 'foo'");
  });

  test("extracts Python KeyError", () => {
    const output = `Traceback (most recent call last):
  File "app.py", line 42, in handler
    result = data['missing_key']
KeyError: 'missing_key'`;
    expect(extractErrorSignature(output)).toBe("KeyError: 'missing_key'");
  });

  test("extracts Node.js TypeError", () => {
    const output = `TypeError: Cannot read properties of undefined (reading 'map')
    at processData (/app/src/index.js:15:12)
    at main (/app/src/index.js:5:3)`;
    expect(extractErrorSignature(output)).toBe(
      "TypeError: Cannot read properties of undefined (reading 'map')"
    );
  });

  test("extracts ReferenceError", () => {
    const output = `ReferenceError: myVariable is not defined
    at Object.<anonymous> (test.js:3:1)`;
    expect(extractErrorSignature(output)).toBe("ReferenceError: myVariable is not defined");
  });

  test("extracts SyntaxError", () => {
    const output = `SyntaxError: Unexpected token '}'
    at new Script (vm.js:99:7)`;
    expect(extractErrorSignature(output)).toBe("SyntaxError: Unexpected token '}'");
  });

  test("extracts Rust panic", () => {
    const output = `thread 'main' panicked at 'index out of bounds: the len is 3 but the index is 5', src/main.rs:4:5`;
    expect(extractErrorSignature(output)).toBe(
      "panic: index out of bounds: the len is 3 but the index is 5"
    );
  });

  test("extracts Go panic", () => {
    const output = `panic: runtime error: invalid memory address or nil pointer dereference
[signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x4a2b3c]`;
    expect(extractErrorSignature(output)).toBe(
      "panic: runtime error: invalid memory address or nil pointer dereference"
    );
  });

  test("extracts generic Error:", () => {
    const output = `error: could not compile 'my-crate'
some other output here`;
    expect(extractErrorSignature(output)).toBe("error: could not compile 'my-crate'");
  });

  test("extracts git fatal errors", () => {
    const output = `fatal: not a git repository (or any of the parent directories): .git`;
    expect(extractErrorSignature(output)).toBe(
      "fatal: not a git repository (or any of the parent directories): .git"
    );
  });

  test("extracts ENOENT errors", () => {
    const output = `ENOENT: no such file or directory, open '/path/to/missing.json'`;
    expect(extractErrorSignature(output)).toBe(
      "ENOENT: no such file or directory, open '/path/to/missing.json'"
    );
  });

  test("returns null for non-error output", () => {
    expect(extractErrorSignature("Build succeeded in 2.3s")).toBeNull();
    expect(extractErrorSignature("All 42 tests passed")).toBeNull();
    expect(extractErrorSignature("npm install completed successfully")).toBeNull();
  });

  test("truncates very long error messages", () => {
    const longError = `TypeError: ${"x".repeat(300)}`;
    const result = extractErrorSignature(longError);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(200);
  });
});
