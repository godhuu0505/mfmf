#!/usr/bin/env python3
"""Exercise provisioning and refusal paths with a stateful fake CLI. No cloud access."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
FAKE = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
state_path = Path(os.environ['GCP_TEST_STATE'])
s = json.loads(state_path.read_text())
with open(os.environ['GCP_TEST_CALLS'], 'a') as log: log.write(json.dumps(args) + '\n')
def opt(name):
    return next((a.split('=', 1)[1] for a in args if a.startswith(name + '=')), None)
def save(value):
    state_path.write_text(json.dumps(s)); print(json.dumps(value)); sys.exit(0)
def starts(*parts): return args[:len(parts)] == list(parts)
project = 'test-project'; number = '123456789'; account = 'ABCDEF-123456-ABCDEF'
if starts('projects', 'describe'):
    save({'projectNumber': s.get('number', number), 'lifecycleState': 'ACTIVE'})
if starts('billing', 'projects', 'describe'):
    save({'billingEnabled': True, 'billingAccountName': 'billingAccounts/' + s.get('account', account)})
if starts('billing', 'accounts', 'describe'): save({'open': True})
if starts('services', 'enable'): save({})
if starts('billing', 'budgets', 'list'): save(s.get('budgets', []))
if starts('billing', 'budgets', 'create'):
    s['budgets'] = [{'displayName': opt('--display-name'),
        'amount': {'specifiedAmount': {'currencyCode': 'JPY', 'units': '3000'}},
        'budgetFilter': {'calendarPeriod': 'MONTH', 'projects': ['projects/' + number], 'creditTypesTreatment': 'EXCLUDE_ALL_CREDITS'},
        'thresholdRules': [{'thresholdPercent': p, 'spendBasis': 'CURRENT_SPEND'} for p in [0.5, 0.9, 1]]}]
    save({})
if starts('artifacts', 'repositories', 'list'):
    if s.get('deny_repo_list'): sys.exit(1)
    save(s.get('repos', []))
if starts('artifacts', 'repositories', 'create'):
    s['repos'] = [{'name': 'projects/test-project/locations/asia-northeast1/repositories/mfmf', 'format': 'DOCKER', 'mode': 'STANDARD_REPOSITORY'}]; save({})
if starts('artifacts', 'repositories', 'get-iam-policy'): save(s.get('repo_policy', {}))
if starts('iam', 'service-accounts', 'list'): save(s.get('accounts', []))
if starts('iam', 'service-accounts', 'create'):
    s.setdefault('accounts', []).append({'email': args[3] + '@test-project.iam.gserviceaccount.com'}); save({})
if starts('iam', 'service-accounts', 'keys', 'list'): save(s.get('keys', []))
if starts('projects', 'get-iam-policy'): save(s.get('project_policy', {}))
if starts('iam', 'workload-identity-pools', 'list'): save(s.get('pools', []))
if starts('iam', 'workload-identity-pools', 'create'):
    s['pools'] = [{'name': 'projects/123456789/locations/global/workloadIdentityPools/mfmf-github', 'state': 'ACTIVE'}]; save({})
if starts('iam', 'workload-identity-pools', 'providers', 'list'): save(s.get('providers', []))
if starts('iam', 'workload-identity-pools', 'providers', 'create-oidc'):
    s['providers'] = [{'name': 'projects/123456789/locations/global/workloadIdentityPools/mfmf-github/providers/github-main',
        'state': 'ACTIVE', 'oidc': {'issuerUri': opt('--issuer-uri')},
        'attributeCondition': opt('--attribute-condition'),
        'attributeMapping': dict(item.split('=', 1) for item in opt('--attribute-mapping').split(','))}]; save({})
if starts('iam', 'service-accounts', 'get-iam-policy'): save(s.get('sa_policy', {}).get(args[3], {}))
if starts('secrets', 'list'): save(s.get('secrets', []))
if starts('secrets', 'create'):
    s.setdefault('secrets', []).append({'name': 'projects/test-project/secrets/' + args[2],
        'replication': {'userManaged': {'replicas': [{'location': 'asia-northeast1'}]}}}); save({})
if starts('secrets', 'get-iam-policy'): save(s.get('secret_policy', {}))
if starts('run', 'services', 'describe'):
    save(s.get('service', {'spec': {'template': {'spec': {'serviceAccountName': 'mfmf-runtime@test-project.iam.gserviceaccount.com'}}}}))
if starts('run', 'services', 'get-iam-policy'): save(s.get('run_policy', {}))
if 'add-iam-policy-binding' in args: save({})
print('Unexpected fake gcloud command', args, file=sys.stderr); sys.exit(2)
'''


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        (self.folder / 'gcloud').write_text(FAKE)
        (self.folder / 'gcloud').chmod(0o755)
        self.state = self.folder / 'state.json'
        self.state.write_text('{}')
        self.log = self.folder / 'calls.jsonl'
        self.env = {**os.environ, 'PATH': str(self.folder) + os.pathsep + os.environ['PATH'],
                    'GCP_TEST_STATE': str(self.state), 'GCP_TEST_CALLS': str(self.log)}

    def invoke(self, apply=True, script='bootstrap.sh', extra=()):
        args = ['bash', str(ROOT / 'scripts/gcp' / script), '--project', 'test-project']
        if script == 'bootstrap.sh':
            args += ['--project-number', '123456789', '--billing-account', 'ABCDEF-123456-ABCDEF']
        elif script == 'grant-deploy-access.sh':
            args += ['--service', 'mfmf-candidate']
        if apply:
            args.append('--apply')
        return subprocess.run(args + list(extra), env=self.env, text=True, capture_output=True)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def configure(self, **values):
        current = json.loads(self.state.read_text()); current.update(values)
        self.state.write_text(json.dumps(current))

    def test_plan_never_contacts_cloud(self):
        self.assertEqual(self.invoke(apply=False).returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_success_is_resource_scoped_and_rerunnable(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        first = self.calls()
        self.assertEqual(self.invoke().returncode, 0)
        second = self.calls()[len(first):]
        self.assertFalse(any('create' in c or 'create-oidc' in c for c in second))
        grants = [c for c in first if 'add-iam-policy-binding' in c]
        self.assertEqual(len(grants), 3)
        self.assertFalse(any(c[0] == 'projects' for c in grants))
        self.assertFalse(any('set-iam-policy' in c or 'keys' in c and 'create' in c for c in first))
        provider = next(c for c in first if 'create-oidc' in c)
        condition = next(a for a in provider if a.startswith('--attribute-condition='))
        for expected in ['1271210275', '19723431', 'refs/heads/main', 'deploy-cloud-run.yml', "'push', 'workflow_dispatch'"]:
            self.assertIn(expected, condition)
        budget = next(c for c in first if c[:3] == ['billing', 'budgets', 'create'])
        self.assertIn('--budget-amount=3000JPY', budget)
        self.assertIn('--filter-projects=projects/123456789', budget)
        self.assertEqual(len([a for a in budget if a.startswith('--threshold-rule=')]), 3)

    def test_wrong_project_and_billing_fail_before_changes(self):
        for config in [{'number': '987'}, {'account': 'OTHER1-123456-ABCDEF'}]:
            with self.subTest(config=config):
                self.state.write_text(json.dumps(config)); self.log.unlink(missing_ok=True)
                self.assertNotEqual(self.invoke().returncode, 0)
                self.assertFalse(any('enable' in c or 'create' in c for c in self.calls()))

    def test_existing_budget_is_never_overwritten(self):
        self.configure(budgets=[{'displayName': 'mfmf-test-project-monthly', 'amount': {'specifiedAmount': {'currencyCode': 'USD', 'units': '3000'}}}])
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertFalse(any('create' in c or 'update' in c for c in self.calls()))

    def test_read_denial_is_not_mistaken_for_missing_repository(self):
        self.configure(deny_repo_list=True)
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertFalse(any(c[:3] == ['artifacts', 'repositories', 'create'] for c in self.calls()))

    def test_user_keys_or_project_roles_stop_iam_grants(self):
        for config in [{'keys': [{'name': 'metadata-only'}]}, {'project_policy': {'bindings': [{'members': ['serviceAccount:mfmf-runtime@test-project.iam.gserviceaccount.com']} ]}}]:
            with self.subTest(config=config):
                self.state.write_text(json.dumps(config)); self.log.unlink(missing_ok=True)
                self.assertNotEqual(self.invoke().returncode, 0)
                self.assertFalse(any('add-iam-policy-binding' in c for c in self.calls()))

    def test_unrelated_or_weakened_wif_is_never_overwritten(self):
        self.configure(providers=[{'name': 'projects/123/locations/global/workloadIdentityPools/mfmf-github/providers/untrusted'}])
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertFalse(any('add-iam-policy-binding' in c or 'update-oidc' in c for c in self.calls()))
        self.state.write_text('{}'); self.assertEqual(self.invoke().returncode, 0)
        state = json.loads(self.state.read_text()); state['providers'][0]['attributeCondition'] = 'true'
        self.state.write_text(json.dumps(state)); self.log.unlink()
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertFalse(any('add-iam-policy-binding' in c or 'update-oidc' in c for c in self.calls()))

    def test_secret_preparation_never_reads_or_writes_values(self):
        self.assertEqual(self.invoke(apply=False, script='prepare-runtime-secrets.sh').returncode, 0)
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.invoke().returncode, 0)
        self.log.unlink()
        result = self.invoke(script='prepare-runtime-secrets.sh')
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertEqual(len([c for c in calls if c[:2] == ['secrets', 'create']]), 4)
        grants = [c for c in calls if 'add-iam-policy-binding' in c]
        self.assertEqual(len(grants), 8)
        self.assertTrue(all(c[0] == 'secrets' for c in grants))
        self.assertFalse(any('versions' in c or 'access' in c for c in calls))
        self.log.unlink()
        self.assertEqual(self.invoke(script='prepare-runtime-secrets.sh').returncode, 0)
        self.assertFalse(any('create' in c for c in self.calls()))

    def test_public_secret_refuses_iam_grants(self):
        self.assertEqual(self.invoke().returncode, 0)
        self.configure(secret_policy={'bindings': [{'members': ['allUsers']}]})
        self.log.unlink()
        self.assertNotEqual(self.invoke(script='prepare-runtime-secrets.sh').returncode, 0)
        self.assertFalse(any('add-iam-policy-binding' in c for c in self.calls()))

    def test_private_service_grant_is_service_scoped(self):
        self.assertEqual(self.invoke(script='grant-deploy-access.sh').returncode, 0)
        grants = [c for c in self.calls() if 'add-iam-policy-binding' in c]
        self.assertEqual(len(grants), 1)
        self.assertEqual(grants[0][:4], ['run', 'services', 'add-iam-policy-binding', 'mfmf-candidate'])
        self.assertIn('--role=roles/run.developer', grants[0])

    def test_public_service_or_wrong_identity_refuses_grant(self):
        for config in [
            {'run_policy': {'bindings': [{'members': ['allUsers']}]}},
            {'service': {'spec': {'template': {'spec': {'serviceAccountName': 'default'}}}}},
            {'service': {'metadata': {'annotations': {'run.googleapis.com/invoker-iam-disabled': 'true'}}, 'spec': {'template': {'spec': {'serviceAccountName': 'mfmf-runtime@test-project.iam.gserviceaccount.com'}}}}},
        ]:
            with self.subTest(config=config):
                self.state.write_text(json.dumps(config)); self.log.unlink(missing_ok=True)
                self.assertNotEqual(self.invoke(script='grant-deploy-access.sh').returncode, 0)
                self.assertFalse(any('add-iam-policy-binding' in c for c in self.calls()))


if __name__ == '__main__':
    unittest.main()
