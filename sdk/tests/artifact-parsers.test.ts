import {
  parseJestJsonArtifact,
  parseJUnitXmlArtifact,
  parseVitestJsonArtifact,
} from "../src/artifact-parsers";

describe("artifact parsers", () => {
  it("parses junit xml artifacts", () => {
    const xml = `
      <testsuite name="suite">
        <testcase classname="math" name="adds" time="0.01"></testcase>
        <testcase classname="math" name="fails" time="0.02">
          <failure>expected 4, received 5</failure>
        </testcase>
      </testsuite>
    `;
    const parsed = parseJUnitXmlArtifact(xml);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].caseTitle).toBe("math::adds");
    expect(parsed[0].passed).toBe(true);
    expect(parsed[1].passed).toBe(false);
    expect(parsed[1].error).toContain("expected 4");
  });

  it("parses jest json artifacts", () => {
    const parsed = parseJestJsonArtifact({
      testResults: [
        {
          assertionResults: [
            {
              fullName: "math adds",
              status: "passed",
              duration: 4,
            },
            {
              fullName: "math fails",
              status: "failed",
              duration: 5,
              failureMessages: ["boom"],
            },
          ],
        },
      ],
    });
    expect(parsed).toHaveLength(2);
    expect(parsed[0].passed).toBe(true);
    expect(parsed[1].passed).toBe(false);
    expect(parsed[1].error).toContain("boom");
  });

  it("parses vitest json artifacts", () => {
    const parsed = parseVitestJsonArtifact({
      files: [
        {
          name: "math",
          tasks: [
            {
              type: "test",
              name: "adds",
              result: { state: "pass", duration: 3 },
            },
            {
              type: "test",
              name: "fails",
              result: {
                state: "fail",
                duration: 4,
                errors: [{ message: "bad output" }],
              },
            },
          ],
        },
      ],
    });
    expect(parsed).toHaveLength(2);
    expect(parsed[0].passed).toBe(true);
    expect(parsed[1].passed).toBe(false);
    expect(parsed[1].error).toContain("bad output");
  });
});
