### Added

- The app overview's **Deploy** menu has a branch picker: pick any branch and deploy its current tip to production once, without merging or changing the production branch. The default selection is the production branch, which behaves exactly like **Redeploy**. Deploy history labels the run `Deploy <branch>@<sha>`, and the next push to the production branch deploys as usual.
- `POST /v1/apps/<id>/deploy {ref}` (RPC `deploys.deploy`) deploys one branch's tip to production; push role required. The deploy row records the new `branch` intent with the branch ref in `actor`.
