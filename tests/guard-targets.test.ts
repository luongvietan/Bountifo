import { describe, expect, it } from "vitest";
import {
  resolveTarget,
  type ScopeTargetInput,
} from "../lib/guard/targets";

function target(
  id: string,
  location: string | null,
  extra: Partial<ScopeTargetInput> = {},
): ScopeTargetInput {
  return {
    target_id: id,
    location,
    name: null,
    category: "website",
    scope_group_ids: [],
    evidence_refs: [`ev_${id}`],
    ...extra,
  };
}

function inventory(
  inScope: ScopeTargetInput[],
  outOfScope: ScopeTargetInput[] = [],
) {
  return { in_scope: inScope, out_of_scope: outOfScope };
}

describe("resolveTarget — exact and bare hosts", () => {
  const inv = inventory([
    target("t1", "https://manage.statuspage.io"),
    target("t2", "api.example.com"),
  ]);

  it("matches an exact URL host with any path", () => {
    const r = resolveTarget("https://manage.statuspage.io/login?x=1", inv);
    expect(r).toMatchObject({
      status: "matched_in_scope",
      target_ids: ["t1"],
      evidence_refs: ["ev_t1"],
    });
  });

  it("matches a bare host against any scheme", () => {
    const r = resolveTarget("http://api.example.com/v2", inv);
    expect(r.status).toBe("matched_in_scope");
  });

  it("is case-insensitive on scheme and host", () => {
    const r = resolveTarget("HTTPS://MANAGE.STATUSPAGE.IO/", inv);
    expect(r.status).toBe("matched_in_scope");
  });

  it("does not match a different host", () => {
    expect(resolveTarget("https://other.example.com", inv).status).toBe(
      "unlisted",
    );
  });
});

describe("resolveTarget — wildcards respect DNS labels", () => {
  const inv = inventory([target("w1", "*.statuspage.io")]);

  it("matches one and multi-label subdomains", () => {
    expect(resolveTarget("https://foo.statuspage.io/", inv).status).toBe(
      "matched_in_scope",
    );
    expect(resolveTarget("https://a.b.statuspage.io/", inv).status).toBe(
      "matched_in_scope",
    );
  });

  it("does not match the apex domain", () => {
    expect(resolveTarget("https://statuspage.io/", inv).status).toBe("unlisted");
  });

  it("never matches lookalike hostnames", () => {
    for (const hostile of [
      "https://evil-statuspage.io/",
      "https://statuspage.io.attacker.tld/",
      "https://notstatuspage.io/",
      "https://statuspage.io.evil.com/",
    ]) {
      expect(resolveTarget(hostile, inv).status).toBe("unlisted");
    }
  });
});

describe("resolveTarget — placeholders and paths", () => {
  const inv = inventory([
    target("z1", "Zendesk Suite https://{subdomain}.zendesk.com/"),
    target("gh", "https://github.com/org/repo"),
    target("sim", "*.prd.platform.simplisafe.com"),
  ]);

  it("matches a single-label {subdomain} placeholder", () => {
    const r = resolveTarget("https://acme.zendesk.com/agent", inv);
    expect(r).toMatchObject({ status: "matched_in_scope", target_ids: ["z1"] });
  });

  it("does not match multi-label or apex under a placeholder", () => {
    expect(resolveTarget("https://a.b.zendesk.com/", inv).status).toBe(
      "unlisted",
    );
    expect(resolveTarget("https://zendesk.com/", inv).status).toBe("unlisted");
  });

  it("matches a URL pattern's path as a segment-boundary prefix", () => {
    expect(resolveTarget("https://github.com/org/repo/issues", inv).status).toBe(
      "matched_in_scope",
    );
    expect(resolveTarget("https://github.com/org/repository", inv).status).toBe(
      "unlisted",
    );
    expect(resolveTarget("https://github.com/org", inv).status).toBe("unlisted");
  });

  it("matches deep wildcard suffixes", () => {
    expect(
      resolveTarget("https://node1.prd.platform.simplisafe.com/", inv).status,
    ).toBe("matched_in_scope");
  });
});

describe("resolveTarget — multi-URL rows and ports", () => {
  it("matches any of several URLs listed in one target row", () => {
    const inv = inventory([
      target("multi", "app.example.com https://admin.example.com/panel"),
    ]);
    expect(resolveTarget("https://app.example.com/", inv).status).toBe(
      "matched_in_scope",
    );
    expect(
      resolveTarget("https://admin.example.com/panel/users", inv).status,
    ).toBe("matched_in_scope");
    expect(resolveTarget("https://admin.example.com/other", inv).status).toBe(
      "unlisted",
    );
  });

  it("honours an explicit port on the pattern", () => {
    const inv = inventory([target("p1", "example.com:8443")]);
    expect(resolveTarget("https://example.com:8443/", inv).status).toBe(
      "matched_in_scope",
    );
    expect(resolveTarget("https://example.com/", inv).status).toBe("unlisted");
  });
});

describe("resolveTarget — specificity and conflicts", () => {
  it("an exact out-of-scope listing overrides a broader in-scope wildcard", () => {
    const inv = inventory(
      [target("in", "*.example.com")],
      [target("out", "admin.example.com")],
    );
    const r = resolveTarget("https://admin.example.com/", inv);
    expect(r).toMatchObject({
      status: "matched_out_of_scope",
      target_ids: ["out"],
    });
  });

  it("an exact in-scope listing overrides a broader out-of-scope wildcard", () => {
    const inv = inventory(
      [target("in", "api.example.com")],
      [target("out", "*.example.com")],
    );
    const r = resolveTarget("https://api.example.com/", inv);
    expect(r.status).toBe("matched_in_scope");
  });

  it("equally specific in/out listings are ambiguous, never order-picked", () => {
    const inv = inventory(
      [target("in", "*.example.com")],
      [target("out", "*.example.com")],
    );
    const r = resolveTarget("https://a.example.com/", inv);
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") {
      expect(r.candidate_target_ids).toEqual(["in", "out"]);
    }
  });

  it("placeholder patterns outrank wildcard hostnames", () => {
    const inv = inventory(
      [target("ph", "{tenant}.zendesk.com")],
      [target("wild", "*.zendesk.com")],
    );
    const r = resolveTarget("https://acme.zendesk.com/", inv);
    expect(r).toMatchObject({ status: "matched_in_scope", target_ids: ["ph"] });
  });

  it("multiple same-side matches at top specificity are not ambiguous", () => {
    const inv = inventory([
      target("a", "*.example.com"),
      target("b", "x.example.com"),
    ]);
    const r = resolveTarget("https://x.example.com/", inv);
    expect(r).toMatchObject({ status: "matched_in_scope", target_ids: ["b"] });
  });
});

describe("resolveTarget — unmatchable input", () => {
  it("unparseable action URLs resolve as unlisted", () => {
    const inv = inventory([target("t1", "*.example.com")]);
    expect(resolveTarget("not a url", inv).status).toBe("unlisted");
  });

  it("textual targets with no URL form never match a URL", () => {
    const inv = inventory([
      target("t1", "Hardware Device", { name: "Hardware Device" }),
    ]);
    expect(resolveTarget("https://hardware.example.com/", inv).status).toBe(
      "unlisted",
    );
  });
});
