#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把插件目录作为一个公开 GitHub 仓库推送。

不需要本机安装 git：全程用 GitHub REST API（建仓库 -> blob -> tree -> commit -> ref）。

用法：
    python publish.py --token ghp_xxx --user 你的用户名 [--repo dsh-plugin-ocr-scan]

Token 需要 public_repo 权限（Fine-grained token 勾选 Contents: write）。
"""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.github.com"
HERE = os.path.dirname(os.path.abspath(__file__))
SKIP = {"publish.py", "publish.ps1"}


def call(method, path, body=None, token=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "dsh-ocr-scan-publisher",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = "Bearer " + token
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            raw = r.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise RuntimeError(f"GitHub API {method} {path} -> HTTP {e.code}: {detail[:500]}") from None


def collect_files(root, username, repo):
    """Collect every file, rewriting the repository placeholder in docs."""
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != ".git" and not d.startswith(".dsh")]
        for fn in filenames:
            if fn in SKIP:
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace("\\", "/")
            with open(full, "rb") as f:
                content = f.read()
            # Replace placeholders with the real repository URL.
            if rel in ("package.json", "README.md"):
                try:
                    text = content.decode("utf-8")
                    text = text.replace("<your-username>", username)
                    text = text.replace("dsh-plugin-ocr-scan", repo) if rel == "package.json" else text
                    content = text.encode("utf-8")
                except UnicodeDecodeError:
                    pass
            out.append((rel, content))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", required=True)
    ap.add_argument("--user", required=True)
    ap.add_argument("--repo", default="dsh-plugin-ocr-scan")
    args = ap.parse_args()

    token, user, repo = args.token, args.user, args.repo

    print(f"[1/5] 创建仓库 {user}/{repo} ...")
    try:
        call("POST", "/user/repos", {
            "name": repo,
            "description": "DeepSeek Harness plugin: scan pages to Markdown with cloud OCR, auto page ordering, Obsidian-ready output",
            "private": False,
            "has_issues": True,
        }, token)
        print("      已创建")
    except RuntimeError as e:
        if "HTTP 422" in str(e):
            print("      仓库已存在，继续")
        else:
            raise

    files = collect_files(HERE, user, repo)
    print(f"[2/5] 收集文件：{len(files)} 个")

    print("[3/5] 上传文件 ...")
    tree = []
    for rel, content in files:
        blob = call("POST", f"/repos/{user}/{repo}/git/blobs", {
            "content": base64.b64encode(content).decode("ascii"),
            "encoding": "base64",
        }, token)
        tree.append({
            "path": rel,
            "mode": "100644",
            "type": "blob",
            "sha": blob["sha"],
        })
        print("      + " + rel)

    print("[4/5] 提交 ...")
    t = call("POST", f"/repos/{user}/{repo}/git/trees", {"tree": tree}, token)
    commit = call("POST", f"/repos/{user}/{repo}/git/commits", {
        "message": "Initial release: OCR scan plugin for DeepSeek Harness",
        "tree": t["sha"],
        "parents": [],
    }, token)

    print("[5/5] 推送 main ...")
    try:
        call("POST", f"/repos/{user}/{repo}/git/refs", {
            "ref": "refs/heads/main",
            "sha": commit["sha"],
        }, token)
    except RuntimeError:
        call("PATCH", f"/repos/{user}/{repo}/git/refs/heads/main", {
            "sha": commit["sha"],
            "force": True,
        }, token)

    print("\n完成！仓库地址：")
    print(f"https://github.com/{user}/{repo}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("失败：" + str(e), file=sys.stderr)
        sys.exit(1)
