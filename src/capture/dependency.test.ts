import { describe, test, expect } from "bun:test";
import { detectDependencyInstalls } from "./dependency.js";

describe("dependency monitor", () => {
  test("detects npm install", () => {
    const results = detectDependencyInstalls("npm install express");
    expect(results).toHaveLength(1);
    expect(results[0]!.manager).toBe("npm");
    expect(results[0]!.packages).toEqual(["express"]);
  });

  test("detects npm i with multiple packages", () => {
    const results = detectDependencyInstalls("npm i lodash axios zod");
    expect(results).toHaveLength(1);
    expect(results[0]!.packages).toEqual(["lodash", "axios", "zod"]);
  });

  test("detects npm install with scoped package", () => {
    const results = detectDependencyInstalls("npm install @xenova/transformers");
    expect(results).toHaveLength(1);
    expect(results[0]!.packages).toEqual(["@xenova/transformers"]);
  });

  test("detects yarn add", () => {
    const results = detectDependencyInstalls("yarn add react react-dom");
    expect(results).toHaveLength(1);
    expect(results[0]!.manager).toBe("yarn");
    expect(results[0]!.packages).toEqual(["react", "react-dom"]);
  });

  test("detects pnpm add", () => {
    const results = detectDependencyInstalls("pnpm add typescript");
    expect(results).toHaveLength(1);
    expect(results[0]!.manager).toBe("pnpm");
  });

  test("detects bun add", () => {
    const results = detectDependencyInstalls("bun add elysia");
    expect(results).toHaveLength(1);
    expect(results[0]!.manager).toBe("bun");
    expect(results[0]!.packages).toEqual(["elysia"]);
  });

  test("detects pip install", () => {
    const results = detectDependencyInstalls("pip install requests flask");
    expect(results).toHaveLength(1);
    expect(results[0]!.manager).toBe("pip");
    expect(results[0]!.packages).toEqual(["requests", "flask"]);
  });

  test("detects pip3 install", () => {
    const results = detectDependencyInstalls("pip3 install numpy");
    expect(results).toHaveLength(1);
    expect(results[0]!.manager).toBe("pip");
  });

  test("detects cargo add", () => {
    const results = detectDependencyInstalls("cargo add serde tokio");
    expect(results).toHaveLength(1);
    expect(results[0]!.manager).toBe("cargo");
    expect(results[0]!.packages).toEqual(["serde", "tokio"]);
  });

  test("detects go get", () => {
    const results = detectDependencyInstalls("go get github.com/gin-gonic/gin");
    expect(results).toHaveLength(1);
    expect(results[0]!.manager).toBe("go");
    expect(results[0]!.packages).toEqual(["github.com/gin-gonic/gin"]);
  });

  test("detects gem install", () => {
    const results = detectDependencyInstalls("gem install rails");
    expect(results).toHaveLength(1);
    expect(results[0]!.manager).toBe("gem");
  });

  test("detects composer require", () => {
    const results = detectDependencyInstalls("composer require laravel/framework");
    expect(results).toHaveLength(1);
    expect(results[0]!.manager).toBe("composer");
  });

  test("ignores npm install without packages (bare install)", () => {
    const results = detectDependencyInstalls("npm install");
    // bare "npm install" without packages — regex shouldn't match since no package name
    // The regex requires at least one non-flag argument
    expect(results).toHaveLength(0);
  });

  test("ignores non-install commands", () => {
    const results = detectDependencyInstalls("npm run build");
    expect(results).toHaveLength(0);
  });

  test("returns empty for unrelated commands", () => {
    const results = detectDependencyInstalls("ls -la");
    expect(results).toHaveLength(0);
  });
});
