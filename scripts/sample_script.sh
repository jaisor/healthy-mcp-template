#!/usr/bin/env bash
# Sets the GitHub secrets and variables the Deploy workflow needs, and writes who may sign in (config/allowed-users.json). See the README, step 6.
#
# Fill in the values below, then run it. It also prints your server address.
# Run it with:  bash scripts/sample_script.sh    (needs the GitHub CLI, https://cli.github.com/; it signs you in if needed)
# Afterwards discard your edits so the keys are never committed:  git checkout scripts/sample_script.sh
set -euo pipefail
cd "$(dirname "$0")/.."   # the repo root

REPO=""                          # your copy of this repo, for example redSlug/healthy-mcp-template
CLOUDFLARE_API_TOKEN=""          # README step 2
CLOUDFLARE_ACCOUNT_ID=""         # README step 2
APP_NAME="healthy"               # the name of your server; lowercase letters, digits and dashes
OAUTH_GITHUB_CLIENT_ID=""        # README step 3
OAUTH_GITHUB_CLIENT_SECRET=""    # README step 3
OAUTH_GOOGLE_CLIENT_ID=""        # README step 4
OAUTH_GOOGLE_CLIENT_SECRET=""    # README step 4
USDA_API_KEY=""                  # README step 5
# Who may sign in. Fill in one or both (not both empty).
ALLOWED_GITHUB_USERS=""          # GitHub usernames, separated by spaces, for example "redSlug octocat"
ALLOWED_GOOGLE_EMAILS=""         # Google account emails, separated by spaces, for example "me@gmail.com friend@example.com"
# Your workers.dev subdomain: only the part before ".workers.dev", for example "my-name" (not "my-name.workers.dev").
# Your server address becomes https://<APP_NAME>.<SUBDOMAIN>.workers.dev. Leave it empty to look it up from your Cloudflare account.
SUBDOMAIN=""

for name in REPO CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID APP_NAME OAUTH_GITHUB_CLIENT_ID OAUTH_GITHUB_CLIENT_SECRET OAUTH_GOOGLE_CLIENT_ID OAUTH_GOOGLE_CLIENT_SECRET USDA_API_KEY; do
  [ -n "${!name}" ] || { echo "Fill in $name first." >&2; exit 1; }
done
[ -n "$ALLOWED_GITHUB_USERS$ALLOWED_GOOGLE_EMAILS" ] || { echo "Fill in ALLOWED_GITHUB_USERS or ALLOWED_GOOGLE_EMAILS (or both) first." >&2; exit 1; }

if [ -z "$SUBDOMAIN" ]; then
  SUBDOMAIN=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" | sed -n 's/.*"subdomain": *"\([^"]*\)".*/\1/p')
  [ -n "$SUBDOMAIN" ] || { echo "Could not look up your workers.dev subdomain. Check the token and account id, and that you picked a subdomain (README step 2), or set SUBDOMAIN yourself." >&2; exit 1; }
fi
WORKER_URL="https://$APP_NAME.$SUBDOMAIN.workers.dev"
echo
echo "Your server address (WORKER_URL): $WORKER_URL"
echo "  GitHub OAuth App homepage URL:  $WORKER_URL"
echo "  GitHub OAuth App callback URL:  $WORKER_URL/callback"
echo "  Google OAuth redirect URI:      $WORKER_URL/callback/google"
echo

command -v gh >/dev/null || { echo "Install the GitHub CLI first: https://cli.github.com/" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || gh auth login

gh variable set APP_NAME --body "$APP_NAME" -R "$REPO"
gh variable set WORKER_URL --body "$WORKER_URL" -R "$REPO"
printf %s "$CLOUDFLARE_API_TOKEN" | gh secret set CLOUDFLARE_API_TOKEN -R "$REPO"
printf %s "$CLOUDFLARE_ACCOUNT_ID" | gh secret set CLOUDFLARE_ACCOUNT_ID -R "$REPO"
printf %s "$OAUTH_GITHUB_CLIENT_ID" | gh secret set OAUTH_GITHUB_CLIENT_ID -R "$REPO"
printf %s "$OAUTH_GITHUB_CLIENT_SECRET" | gh secret set OAUTH_GITHUB_CLIENT_SECRET -R "$REPO"
printf %s "$OAUTH_GOOGLE_CLIENT_ID" | gh secret set OAUTH_GOOGLE_CLIENT_ID -R "$REPO"
printf %s "$OAUTH_GOOGLE_CLIENT_SECRET" | gh secret set OAUTH_GOOGLE_CLIENT_SECRET -R "$REPO"
printf %s "$USDA_API_KEY" | gh secret set USDA_API_KEY -R "$REPO"
openssl rand -hex 32 | tr -d '\n' | gh secret set COOKIE_ENCRYPTION_KEY -R "$REPO"
# Who may sign in: look up each username's numeric GitHub id, add each Google email, write the file, and commit and push just that file.
users=""
for login in $ALLOWED_GITHUB_USERS; do
  id=$(gh api "users/$login" --jq .id) || { echo "Could not find GitHub user $login." >&2; exit 1; }
  users="$users${users:+,}
  { \"github_id\": $id, \"login\": \"$login\" }"
done
for email in $ALLOWED_GOOGLE_EMAILS; do
  case "$email" in *@*) ;; *) echo "$email is not an email address." >&2; exit 1 ;; esac
  users="$users${users:+,}
  { \"google_email\": \"$(printf %s "$email" | tr '[:upper:]' '[:lower:]')\" }"
done
printf '[%s\n]\n' "$users" > config/allowed-users.json
git add config/allowed-users.json
git commit -m "Set who may sign in" -- config/allowed-users.json
git push || echo "Could not push. Push config/allowed-users.json to your repo yourself."

echo "Done. Now run: git checkout scripts/sample_script.sh"
