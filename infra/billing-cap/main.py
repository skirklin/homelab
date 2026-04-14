"""
Cloud Function that disables billing on the project when budget threshold is exceeded.
Triggered by a Pub/Sub message from a Google Cloud Billing Budget.

Setup:
  1. Create Pub/Sub topic: gcloud pubsub topics create billing-alerts
  2. Create budget in Billing → Budgets & alerts, set amount to $20,
     connect to the billing-alerts Pub/Sub topic, set threshold at 100%
  3. Deploy this function (see deploy.sh)
  4. Grant the Cloud Function's service account the "Billing Account Viewer"
     and "Project Billing Manager" roles on the billing account
"""

import base64
import json
import os

from google.cloud import billing_v1


PROJECT_ID = os.environ.get("GCP_PROJECT_ID", os.environ.get("GCLOUD_PROJECT"))
BUDGET_LIMIT_USD = float(os.environ.get("BUDGET_LIMIT_USD", "20"))


def budget_alert(event, context):
    """Triggered by Pub/Sub message from billing budget."""
    pubsub_data = base64.b64decode(event["data"]).decode("utf-8")
    notification = json.loads(pubsub_data)

    cost = notification.get("costAmount", 0)
    budget = notification.get("budgetAmount", BUDGET_LIMIT_USD)

    print(f"Current cost: ${cost:.2f}, Budget: ${budget:.2f}")

    if cost >= BUDGET_LIMIT_USD:
        print(f"Cost ${cost:.2f} exceeds limit ${BUDGET_LIMIT_USD:.2f} — disabling billing")
        _disable_billing(PROJECT_ID)
    else:
        print(f"Cost ${cost:.2f} is under limit ${BUDGET_LIMIT_USD:.2f} — no action")


def _disable_billing(project_id):
    """Remove billing account from the project, which stops all paid API usage."""
    client = billing_v1.CloudBillingClient()
    project_name = f"projects/{project_id}"

    # Get current billing info
    billing_info = client.get_project_billing_info(name=project_name)

    if not billing_info.billing_enabled:
        print(f"Billing already disabled for {project_id}")
        return

    # Disable by clearing the billing account
    billing_info.billing_account_name = ""
    client.update_project_billing_info(
        name=project_name,
        project_billing_info=billing_info,
    )
    print(f"Billing disabled for {project_id}")
