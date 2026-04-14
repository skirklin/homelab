# Billing Cap

Cloud Function that disables billing on the GCP project when monthly spend exceeds a threshold. This exists because Google Cloud budgets are **alerts only** — they don't stop usage.

## How it works

1. A **billing budget** sends notifications to a Pub/Sub topic (`billing-alerts`)
2. This **Cloud Function** triggers on each notification
3. If the reported cost exceeds `BUDGET_LIMIT_USD` (default: $20), it **removes the billing account from the project**, which immediately stops all paid API usage

To re-enable, re-link the billing account in the Cloud Console under Billing → Account management.

## Setup

### Prerequisites

- `gcloud` CLI authenticated
- Billing budget created pointing to Pub/Sub topic `billing-alerts`

### Create the Pub/Sub topic

```bash
gcloud pubsub topics create billing-alerts --project=recipe-box-335721
```

### Create the budget

1. Go to **Billing → Budgets & alerts → Create budget**
2. Set amount to **$20**
3. Under **Actions**, connect to Pub/Sub topic `billing-alerts`
4. Set threshold rules at 50% (email heads-up) and 100% (triggers the kill)

### Deploy the function

```bash
GCP_PROJECT_ID=recipe-box-335721 ./infra/billing-cap/deploy.sh
```

### Grant permissions

The function's service account needs two roles:

```bash
# Viewer on the billing account (to read the billing link)
gcloud billing accounts add-iam-policy-binding 017A18-D0FF65-774A85 \
  --member=serviceAccount:recipe-box-335721@appspot.gserviceaccount.com \
  --role=roles/billing.viewer

# Project Billing Manager on the project (to unlink billing)
gcloud projects add-iam-policy-binding recipe-box-335721 \
  --member=serviceAccount:recipe-box-335721@appspot.gserviceaccount.com \
  --role=roles/billing.projectManager
```

## After hitting the cap

Budget notifications can lag several hours, so also set per-API daily quotas in the Cloud Console as a secondary safeguard (APIs & Services → select API → Quotas & System Limits).

When the function fires mid-cycle (e.g., spend already exceeds the limit from a prior incident), re-enabling billing will cause it to fire again. To break the loop:

1. Temporarily raise `BUDGET_LIMIT_USD` above current spend, or raise the budget amount
2. Re-link billing
3. Lower back to $20 after the billing cycle resets on the 1st of the month
