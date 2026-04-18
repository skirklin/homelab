#!/usr/bin/env python3
"""
Create an API token for the homelab API service.

Generates an hlk_-prefixed token, stores the SHA-256 hash in PocketBase's
api_tokens collection, and prints the plaintext token (store it securely).

Usage:
  python3 services/scripts/create-api-token.py --name "CronJob" --user scott.kirklin@gmail.com
  python3 services/scripts/create-api-token.py --name "MCP" --user scott.kirklin@gmail.com --pb-url http://127.0.0.1:8090

Environment:
  PB_URL             PocketBase URL (default: http://127.0.0.1:8090)
  PB_ADMIN_EMAIL     Admin email for PocketBase auth
  PB_ADMIN_PASSWORD  Admin password for PocketBase auth
"""

import argparse
import hashlib
import json
import os
import secrets
import sys
import urllib.request
import urllib.error


def main():
    parser = argparse.ArgumentParser(description="Create an API token for the homelab API service")
    parser.add_argument("--name", required=True, help="Token name (e.g. 'CronJob', 'MCP')")
    parser.add_argument("--user", required=True, help="User email to associate the token with")
    parser.add_argument("--pb-url", default=None, help="PocketBase URL (default: PB_URL env or http://127.0.0.1:8090)")
    args = parser.parse_args()

    pb_url = (args.pb_url or os.environ.get("PB_URL", "http://127.0.0.1:8090")).rstrip("/")
    admin_email = os.environ.get("PB_ADMIN_EMAIL", "")
    admin_password = os.environ.get("PB_ADMIN_PASSWORD", "")

    if not admin_email or not admin_password:
        print("Error: PB_ADMIN_EMAIL and PB_ADMIN_PASSWORD must be set", file=sys.stderr)
        sys.exit(1)

    # Auth as admin
    auth_data = json.dumps({"identity": admin_email, "password": admin_password}).encode()
    req = urllib.request.Request(
        f"{pb_url}/api/collections/_superusers/auth-with-password",
        data=auth_data,
        headers={"Content-Type": "application/json"},
    )
    try:
        resp = urllib.request.urlopen(req)
        admin_token = json.loads(resp.read())["token"]
    except urllib.error.HTTPError as e:
        print(f"Admin auth failed: {e.read().decode()}", file=sys.stderr)
        sys.exit(1)

    # Find the user
    req = urllib.request.Request(
        f"{pb_url}/api/collections/users/records?filter=email%3D%22{args.user}%22",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    resp = urllib.request.urlopen(req)
    users = json.loads(resp.read())
    if not users["items"]:
        print(f"User not found: {args.user}", file=sys.stderr)
        sys.exit(1)
    user_id = users["items"][0]["id"]

    # Generate token
    token = "hlk_" + secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()

    # Store in PocketBase
    create_data = json.dumps({
        "name": args.name,
        "token_hash": token_hash,
        "user": user_id,
    }).encode()
    req = urllib.request.Request(
        f"{pb_url}/api/collections/api_tokens/records",
        data=create_data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {admin_token}",
        },
    )
    try:
        resp = urllib.request.urlopen(req)
        record = json.loads(resp.read())
        print(f"Token created: {record['id']}")
        print(f"  Name: {args.name}")
        print(f"  User: {args.user} ({user_id})")
        print(f"  Token: {token}")
        print()
        print("Store this token securely — it cannot be retrieved later.")
    except urllib.error.HTTPError as e:
        print(f"Failed to create token: {e.read().decode()}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
