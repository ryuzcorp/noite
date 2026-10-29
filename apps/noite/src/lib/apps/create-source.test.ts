import { expect, test } from "bun:test";

import { parseGitHubRepo } from "./create-source";
import { slugifyName } from "./identity";
import { TEMPLATES } from "./templates";

test("a GitHub URL prefills the slug from the repo name", () => {
  expect(parseGitHubRepo("https://github.com/octocat/Hello-World")).toEqual({
    name: "Hello-World",
    owner: "octocat",
    repo: "Hello-World",
    slug: "hello-world",
  });
  expect(
    parseGitHubRepo("https://github.com/octocat/Hello-World.git")?.slug
  ).toBe("hello-world");
  expect(parseGitHubRepo("https://github.com/ryuzcorp/My_Cool.App")?.slug).toBe(
    "my-cool-app"
  );
});

test("a GitHub folder link names the ref and the monorepo folder", () => {
  expect(
    parseGitHubRepo("https://github.com/acme/mono/tree/main/apps/web-site")
  ).toEqual({
    name: "web-site",
    owner: "acme",
    path: "apps/web-site",
    ref: "main",
    repo: "mono",
    slug: "web-site",
  });
  // A branch link with no folder: the ref only, named after the repo.
  expect(parseGitHubRepo("https://github.com/acme/mono/tree/v2")).toEqual({
    name: "mono",
    owner: "acme",
    ref: "v2",
    repo: "mono",
    slug: "mono",
  });
});

test("only the exact GitHub https shape prefills", () => {
  for (const bad of [
    "",
    "   ",
    "not a url",
    "github.com/octocat/Hello-World",
    "http://github.com/octocat/Hello-World",
    "git://github.com/octocat/Hello-World",
    "https://gitlab.com/octocat/Hello-World",
    "https://github.com.evil.test/octocat/Hello-World",
    "https://github.com:8443/octocat/Hello-World",
    "https://user:pass@github.com/octocat/Hello-World",
    "https://github.com/octocat/Hello-World?ref=main",
    "https://github.com/octocat/Hello-World#main",
    "https://github.com/octocat",
    "https://github.com/octocat/Hello-World/extra",
    "https://github.com/octocat/Hello-World/tree",
    "https://github.com/octocat/Hello-World/blob/main/README.md",
    "https://github.com/-octocat/Hello-World",
  ]) {
    expect(parseGitHubRepo(bad)).toBeNull();
  }
});

test("a template's id is already the slug the picker prefills", () => {
  expect(TEMPLATES.map((template) => template.id)).toEqual([
    "ilha-void",
    "tanstack-start",
  ]);

  for (const template of TEMPLATES) {
    expect(slugifyName(template.id)).toBe(template.id);
    // One repo holds every template; each id maps to its folder.
    expect(template.url).toBe("https://github.com/ryuzcorp/noite-templates");
    expect(template.path).toBe(`templates/${template.id}`);
  }
});
