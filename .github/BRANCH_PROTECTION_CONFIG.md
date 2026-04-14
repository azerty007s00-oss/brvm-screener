# Branch Protection Rules for `main`

## Configuration

1. **Require pull request reviews before merging**: Ensure that at least one team member reviews and approves the pull request before it can be merged into the `main` branch.
2. **Require status checks to pass before merging**: Any required status checks must pass before the pull request can be merged.
3. **Include administrators**: Even administrators must adhere to these rules.
4. **Require signed commits**: Ensure that commits made to the branch are signed with a GPG key for added security.

## Recommended Workflow Process

1. **Create a Feature Branch**: Start by creating a new branch off of `main` for any new features or fixes. The naming convention should include the feature or issue title, e.g., `feature/new-feature` or `bugfix/fix-issue`.
2. **Make Changes on the Feature Branch**: Implement the changes or new feature in this branch.
3. **Open a Pull Request**: Once the work is complete, open a pull request to merge the feature branch into `main`. Ensure the pull request title description clearly communicates the changes.
4. **Review and Approval**: Request at least one other team member to review the pull request. Ensure to address any comments or suggestions made by the reviewer(s).
5. **Merge the Pull Request**: After the pull request has been approved and all required status checks have passed, merge it into the `main` branch.

6. **Delete the Feature Branch**: After merging, delete the feature branch to keep the repository clean. 

By following these branch protection rules and recommended workflows, we ensure a high standard of code quality and collaborative efficiency within the development process.