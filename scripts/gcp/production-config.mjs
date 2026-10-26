export const PROJECT = "mfmf-499612";
export const PROJECT_NUMBER = "92772745697";
export const REGION = "asia-northeast1";
export const SERVICE = "mfmf-candidate";
export const RUNTIME = `mfmf-runtime@${PROJECT}.iam.gserviceaccount.com`;
export const SERVICE_NAME = `projects/${PROJECT}/locations/${REGION}/services/${SERVICE}`;
export const PUBLIC_ORIGIN = "https://mfmf-candidate-wspqvmhj6q-an.a.run.app";
export const IMAGE_BASE = `${REGION}-docker.pkg.dev/${PROJECT}/mfmf/${SERVICE}`;

export function requireContinuousContext(env) {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REF !== "refs/heads/main" ||
      env.GITHUB_EVENT_NAME !== "push" || env.GCP_DEPLOY_ENABLED !== "true" ||
      env.GITHUB_WORKFLOW_REF !== "godhuu0505/mfmf/.github/workflows/deploy-production.yml@refs/heads/main" ||
      env.GCP_PROJECT_ID !== PROJECT || env.GCP_PROJECT_NUMBER !== PROJECT_NUMBER ||
      !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ||
      !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? "") || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? "")) {
    throw new Error("Continuous deployment requires the enabled production main push context; input withheld.");
  }
}
