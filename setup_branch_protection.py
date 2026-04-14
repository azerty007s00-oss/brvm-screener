import os
import requests

# Load environment variables
GITHUB_TOKEN = os.getenv('GITHUB_TOKEN')
REPO_OWNER = os.getenv('REPO_OWNER', 'azerty007s00-oss')
REPO_NAME = os.getenv('REPO_NAME', 'brvm-screener')

# GitHub API url for branch protection
url = f'https://api.github.com/repos/{{REPO_OWNER}}/{{REPO_NAME}}/branches/main/protection'

# Branch protection rules
protection_rules = {
    "required_status_checks": {
        "strict": True,
        "checks": []
    },
    "required_pull_request_reviews": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews": True
    },
    "enforce_admins": True,
    "required_linear_history": True,
    "allow_force_pushes": False,
    "blocked_pull_request_reviews": [],
    "dismissal_restrictions": {
        "users": [],
        "teams": []
    },
    "required_conversation_resolution": True,
    "allow_merge_commit": True,
    "allow_squash_merge": True,
    "allow_rebase_merge": True,
    "delete_branch_on_merge": True
}

# Set up headers with authorization
headers = {
    'Authorization': f'token {{GITHUB_TOKEN}}',
    'Accept': 'application/vnd.github.v3+json'
}

# Make the API call to set branch protection rules
response = requests.put(url, json=protection_rules, headers=headers)

if response.status_code == 200:
    print("Branch protection rules set successfully!")
else:
    print(f"Failed to set branch protection rules: {{response.json()}}")
