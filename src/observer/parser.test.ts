import { describe, it, expect } from "bun:test";
import { parseObservationXml } from "./parser.js";

describe("parseObservationXml", () => {
  it("parses a full observation with all fields", () => {
    const xml = `<observation>
  <type>bugfix</type>
  <title>Fixed OAuth2 PKCE flow in authentication</title>
  <narrative>Authentication now validates code_verifier parameter, preventing code interception attacks.</narrative>
  <facts>
    <fact>PKCE prevents authorization code interception</fact>
    <fact>Token endpoint validates code_verifier</fact>
  </facts>
  <concepts>
    <concept>oauth</concept>
    <concept>security</concept>
    <concept>authentication</concept>
  </concepts>
</observation>`;

    const result = parseObservationXml(xml);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("bugfix");
    expect(result!.title).toBe("Fixed OAuth2 PKCE flow in authentication");
    expect(result!.narrative).toContain("code_verifier");
    expect(result!.facts).toHaveLength(2);
    expect(result!.facts[0]).toBe("PKCE prevents authorization code interception");
    expect(result!.concepts).toEqual(["oauth", "security", "authentication"]);
  });

  it("returns null for <skip/>", () => {
    expect(parseObservationXml("<skip/>")).toBeNull();
    expect(parseObservationXml("<skip />")).toBeNull();
    expect(parseObservationXml("This is trivial. <skip/>")).toBeNull();
  });

  it("parses observation with no facts or concepts", () => {
    const xml = `<observation>
  <type>change</type>
  <title>Updated deployment config</title>
  <narrative>Changed nginx timeout from 30s to 60s.</narrative>
</observation>`;

    const result = parseObservationXml(xml);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("change");
    expect(result!.title).toBe("Updated deployment config");
    expect(result!.facts).toEqual([]);
    expect(result!.concepts).toEqual([]);
  });

  it("returns null for invalid XML", () => {
    expect(parseObservationXml("just plain text")).toBeNull();
    expect(parseObservationXml("")).toBeNull();
    expect(parseObservationXml("<observation></observation>")).toBeNull(); // no type/title
  });

  it("handles XML with surrounding text", () => {
    const xml = `Here's the observation:
<observation>
  <type>discovery</type>
  <title>Found rate limiter in API gateway</title>
  <narrative>API uses token bucket with 100 req/min per user.</narrative>
</observation>
That's it.`;

    const result = parseObservationXml(xml);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("discovery");
    expect(result!.title).toBe("Found rate limiter in API gateway");
  });

  it("normalizes type to lowercase", () => {
    const xml = `<observation><type>BUGFIX</type><title>test</title></observation>`;
    const result = parseObservationXml(xml);
    expect(result!.type).toBe("bugfix");
  });
});
