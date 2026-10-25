#!/usr/bin/env python3
"""Probe Copilot's catalog with the workflow token; never log credentials."""
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request

ENDPOINT = os.environ.get("COPILOT_MODELS_URL", "https://api.githubcopilot.com/models")


def main():
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        sys.exit("GITHUB_TOKEN is required")
    output = Path("results")
    output.mkdir(exist_ok=True)
    request = urllib.request.Request(ENDPOINT, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": "copilot-models-actions-test/1.0",
    })
    try:
        response = urllib.request.urlopen(request, timeout=60)
    except urllib.error.HTTPError as error:
        response = error
    except urllib.error.URLError as error:
        sys.exit(f"Copilot request failed: {error.reason}")
    with response:
        status = response.code
        body = response.read().decode("utf-8", errors="replace")
    # Defensive redaction, including in error responses and artifacts.
    body = body.replace(token, "[REDACTED]")
    (output / "response.json").write_text(body + "\n")
    (output / "status.json").write_text(json.dumps({"endpoint": ENDPOINT, "status": status}, indent=2) + "\n")
    summary = f"## Copilot model catalog\n\nEndpoint: `{ENDPOINT}`\n\nHTTP status: **{status}**\n\n"
    print(f"GET {ENDPOINT}: HTTP {status}")
    success = False
    if status == 200:
        try:
            catalog = json.loads(body)
            models = catalog["data"]
            if not isinstance(models, list) or not all(isinstance(m, dict) and isinstance(m.get("id"), str) for m in models):
                raise ValueError("Expected data to be a list of models with string IDs")
            ids = sorted({model["id"] for model in models})
            (output / "model-ids.txt").write_text("\n".join(ids) + "\n")
            print(f"\n{len(ids)} models returned:\n" + "\n".join(ids))
            summary += f"Models returned: **{len(ids)}**\n\n```text\n" + "\n".join(ids) + "\n```\n"
            success = True
        except (ValueError, KeyError, TypeError) as error:
            summary += f"Unexpected catalog format: {error}\n"
            print(f"Unexpected catalog format: {error}", file=sys.stderr)
    else:
        summary += "Request failed. See the response.json artifact for the server response.\n"
        print(body, file=sys.stderr)
    (output / "summary.md").write_text(summary)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as handle:
            handle.write(summary)
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
