import { runShell } from "./shell";
import { clip, err, type Tool } from "./types";

const API = "https://api.github.com";

async function gh(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "agentx",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { ok: res.ok, status: res.status, json };
}

interface In {
  action: "create_pr" | "list_prs" | "view_pr" | "comment" | "create_repo" | "list_repos" | "get_issue" | "list_issues" | "api";
  repo?: string;
  title?: string;
  body?: string;
  head?: string;
  base?: string;
  draft?: boolean;
  number?: number;
  name?: string;
  private?: boolean;
  method?: string;
  path?: string;
  payload?: Record<string, unknown>;
}

export const github: Tool<In> = {
  spec: {
    name: "github",
    description:
      "GitHub API using the configured token. Actions: create_pr(repo,title,body,head,base?), list_prs(repo), view_pr(repo,number), comment(repo,number,body), create_repo(name,private?,description as body), list_repos, get_issue(repo,number), list_issues(repo), api(method,path,payload) for anything else. repo is 'owner/name'. Use shell for git clone/commit/push (git_push tool for authenticated push).",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create_pr", "list_prs", "view_pr", "comment", "create_repo", "list_repos", "get_issue", "list_issues", "api"],
        },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        head: { type: "string" },
        base: { type: "string" },
        draft: { type: "boolean" },
        number: { type: "number" },
        name: { type: "string" },
        private: { type: "boolean" },
        method: { type: "string" },
        path: { type: "string" },
        payload: { type: "object" },
      },
      required: ["action"],
    },
  },
  summarize: (i) => `${i.action} ${i.repo ?? i.name ?? i.path ?? ""}`,
  async run(i, ctx) {
    const t = ctx.githubToken;
    if (!t) return err("no GitHub token configured. Run `agentx config --github-token <token>` or ask the user for one.");
    const pick = (o: Record<string, unknown>, keys: string[]) =>
      Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
    let r;
    switch (i.action) {
      case "create_pr": {
        if (!i.repo || !i.title || !i.head) return err("repo, title, head required");
        let base = i.base;
        if (!base) {
          const info = await gh(t, "GET", `/repos/${i.repo}`);
          base = (info.json as { default_branch?: string }).default_branch ?? "main";
        }
        r = await gh(t, "POST", `/repos/${i.repo}/pulls`, { title: i.title, body: i.body ?? "", head: i.head, base, draft: i.draft ?? false });
        if (r.ok) return { output: `PR created: ${(r.json as { html_url: string }).html_url}` };
        break;
      }
      case "list_prs":
        r = await gh(t, "GET", `/repos/${i.repo}/pulls?state=open&per_page=30`);
        if (r.ok) return { output: JSON.stringify((r.json as Record<string, unknown>[]).map((p) => pick(p, ["number", "title", "html_url", "user", "head"])).map((p) => ({ ...p, user: (p.user as { login: string })?.login, head: (p.head as { ref: string })?.ref })), null, 1) };
        break;
      case "view_pr": {
        r = await gh(t, "GET", `/repos/${i.repo}/pulls/${i.number}`);
        if (!r.ok) break;
        const pr = pick(r.json as Record<string, unknown>, ["number", "title", "body", "state", "html_url", "mergeable", "head", "base"]);
        const comments = await gh(t, "GET", `/repos/${i.repo}/issues/${i.number}/comments?per_page=50`);
        const reviews = await gh(t, "GET", `/repos/${i.repo}/pulls/${i.number}/comments?per_page=50`);
        const fmt = (c: Record<string, unknown>) => `- @${(c.user as { login: string })?.login}${c.path ? ` [${c.path}:${c.line}]` : ""}: ${c.body}`;
        return {
          output: clip(
            JSON.stringify(pr, null, 1) +
              "\n\nComments:\n" +
              ((comments.json as Record<string, unknown>[]) ?? []).map(fmt).join("\n") +
              "\n\nReview comments:\n" +
              ((reviews.json as Record<string, unknown>[]) ?? []).map(fmt).join("\n"),
          ),
        };
      }
      case "comment":
        r = await gh(t, "POST", `/repos/${i.repo}/issues/${i.number}/comments`, { body: i.body });
        if (r.ok) return { output: `commented: ${(r.json as { html_url: string }).html_url}` };
        break;
      case "create_repo":
        r = await gh(t, "POST", "/user/repos", { name: i.name, private: i.private ?? true, description: i.body ?? "", auto_init: false });
        if (r.ok) return { output: `repo created: ${(r.json as { html_url: string }).html_url} (clone: ${(r.json as { clone_url: string }).clone_url})` };
        break;
      case "list_repos":
        r = await gh(t, "GET", "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member");
        if (r.ok) return { output: clip((r.json as { full_name: string; private: boolean; pushed_at: string }[]).map((x) => `${x.full_name}${x.private ? " (private)" : ""}  ${x.pushed_at}`).join("\n")) };
        break;
      case "get_issue":
        r = await gh(t, "GET", `/repos/${i.repo}/issues/${i.number}`);
        if (r.ok) return { output: clip(JSON.stringify(pick(r.json as Record<string, unknown>, ["number", "title", "body", "state", "html_url", "labels"]), null, 1)) };
        break;
      case "list_issues":
        r = await gh(t, "GET", `/repos/${i.repo}/issues?state=open&per_page=50`);
        if (r.ok) return { output: clip((r.json as { number: number; title: string; pull_request?: unknown }[]).filter((x) => !x.pull_request).map((x) => `#${x.number} ${x.title}`).join("\n") || "no open issues") };
        break;
      case "api":
        if (!i.path) return err("path required");
        r = await gh(t, i.method ?? "GET", i.path, i.payload);
        return { output: clip(typeof r.json === "string" ? r.json : JSON.stringify(r.json, null, 1)), isError: !r.ok };
    }
    return err(`GitHub API ${r?.status}: ${clip(JSON.stringify(r?.json), 2000)}`);
  },
};

export const gitPush: Tool<{ remote?: string; branch?: string; set_upstream?: boolean; force_with_lease?: boolean; cwd?: string }> = {
  spec: {
    name: "git_push",
    description:
      "Push the current repo to GitHub using the configured token (works without any git credential setup). Defaults: remote=origin, branch=current, set_upstream=true.",
    input_schema: {
      type: "object",
      properties: {
        remote: { type: "string" },
        branch: { type: "string" },
        set_upstream: { type: "boolean" },
        force_with_lease: { type: "boolean" },
        cwd: { type: "string" },
      },
    },
  },
  summarize: (i) => `${i.remote ?? "origin"} ${i.branch ?? "(current)"}`,
  async run(i, ctx) {
    const cwd = i.cwd ?? ctx.cwd;
    const remote = i.remote ?? "origin";
    const url = (await runShell(`git remote get-url ${remote}`, cwd, 20_000)).stdout.trim();
    if (!url) return err(`remote ${remote} not found`);
    let branch = i.branch;
    if (!branch) branch = (await runShell("git rev-parse --abbrev-ref HEAD", cwd, 20_000)).stdout.trim();
    let authed = url;
    const m = url.match(/^https:\/\/(?:[^@]+@)?github\.com\/(.+)$/) ?? url.match(/^git@github\.com:(.+)$/);
    if (m && ctx.githubToken) authed = `https://x-access-token:${ctx.githubToken}@github.com/${m[1]}`;
    const flags = [i.set_upstream === false ? "" : "-u", i.force_with_lease ? "--force-with-lease" : ""].filter(Boolean).join(" ");
    const r = await runShell(`git push ${flags} "${authed}" ${branch}`, cwd, 180_000);
    const out = (r.stdout + "\n" + r.stderr).replaceAll(ctx.githubToken, "***") + `\n[exit code ${r.code}]`;
    if (r.code === 0 && i.set_upstream !== false) {
      await runShell(`git branch --set-upstream-to=${remote}/${branch} ${branch}`, cwd, 20_000);
    }
    return { output: clip(out), isError: r.code !== 0 };
  },
};
