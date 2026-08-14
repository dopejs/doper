import { describe, expect, it } from "vitest";

import { discoverSubresources, evaluateResourcePolicy } from "./audit-coop-coep.mjs";

describe("COOP/COEP audit", () => {
  it("discovers fetched resources and resolves the document base URL", () => {
    const html = `
      <base href="https://cdn.example.com/assets/">
      <script type="module" src="app.js"></script>
      <link rel="stylesheet" href="style.css">
      <a href="not-a-resource.html">navigation</a>
    `;

    expect(discoverSubresources(html, "https://app.example.com/page")).toEqual([
      { corsMode: "cors", tag: "script", url: "https://cdn.example.com/assets/app.js" },
      {
        corsMode: "no-cors",
        tag: "link",
        url: "https://cdn.example.com/assets/style.css",
      },
    ]);
  });

  it("blocks unlabelled cross-origin resources and accepts explicit CORP", () => {
    const resource = {
      corsMode: "no-cors",
      tag: "img",
      url: "https://cdn.example.net/image.png",
    };

    expect(evaluateResourcePolicy(resource, "https://app.example.com", new Headers()).status).toBe(
      "block",
    );
    expect(
      evaluateResourcePolicy(
        resource,
        "https://app.example.com",
        new Headers({ "Cross-Origin-Resource-Policy": "cross-origin" }),
      ).status,
    ).toBe("pass");
  });

  it("requires an exact origin for credentialed CORS", () => {
    const resource = {
      corsMode: "cors-with-credentials",
      tag: "img",
      url: "https://cdn.example.net/image.png",
    };

    expect(
      evaluateResourcePolicy(
        resource,
        "https://app.example.com",
        new Headers({ "Access-Control-Allow-Origin": "*" }),
      ).status,
    ).toBe("block");
    expect(
      evaluateResourcePolicy(
        resource,
        "https://app.example.com",
        new Headers({
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Origin": "https://app.example.com",
        }),
      ).status,
    ).toBe("pass");
  });
});
