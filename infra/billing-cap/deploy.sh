#!/usr/bin/env bash
set -euo pipefail

# Deploy the billing cap Cloud Function
# Prerequisites:
#   - gcloud CLI authenticated
#   - Pub/Sub topic "billing-alerts" created
#   - Budget configured in Billing → Budgets & alerts pointing to that topic
#   - Cloud Function service account has "Project Billing Manager" role

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
REGION="${GCP_REGION:-us-central1}"

gcloud functions deploy billing-cap \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --runtime=python312 \
  --trigger-topic=billing-alerts \
  --entry-point=budget_alert \
  --set-env-vars="GCP_PROJECT_ID=$PROJECT_ID,BUDGET_LIMIT_USD=20" \
  --memory=128Mi \
  --timeout=60s \
  --source="$(dirname "$0")"

echo ""
echo "Deployed. Now make sure the function's service account has billing permissions:"
echo "  SA: ${PROJECT_ID}@appspot.gserviceaccount.com"
echo ""
echo "Grant roles on your BILLING ACCOUNT (not project):"
echo "  gcloud billing accounts get-iam-policy BILLING_ACCOUNT_ID"
echo "  gcloud billing accounts add-iam-policy-binding BILLING_ACCOUNT_ID \\"
echo "    --member=serviceAccount:${PROJECT_ID}@appspot.gserviceaccount.com \\"
echo "    --role=roles/billing.projectManager"
