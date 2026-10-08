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
    "https://github.com/-octocat/Hello-World",
  ]) {
    expect(parseGitHubRepo(bad)).toBeNull();
  }
});

test("a template's id is already the slug the picker prefills", () => {
  expect(TEMPLATES.map((template) => template.id)).toEqual([
    "oxide",
    "tanstack-start",
  ]);
  for (const template of TEMPLATES) {
    expect(slugifyName(template.id)).toBe(template.id);
    expect(parseGitHubRepo(template.url)?.slug).toBe(
      template.url.split("/").at(-1)
    );
  }
});
