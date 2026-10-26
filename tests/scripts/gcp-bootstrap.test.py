#!/usr/bin/env python3
"""Exercise provisioning and refusal paths with a stateful fake CLI. No cloud access."""
import ast
import json
import os
from pathlib import Path
import re
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
    s['repos'] = [{'name': 'projects/test-project/locations/asia-northeast1/repositories/mfmf', 'format': 'DOCKER', 'mode': 'STANDARD_REPOSITORY', 'description': opt('--description')}]; save({})
if starts('artifacts', 'repositories', 'describe'): save(s.get('repo_describe', s.get('repos', [{}])[0]))
if starts('artifacts', 'repositories', 'set-cleanup-policies'):
    policies = json.loads(Path(opt('--policy')).read_text())
    s['repos'][0]['cleanupPolicies'] = {p['name']: {'id': p['name'], 'action': p['action']['type'].upper(),
        **({'condition': {'tagState': 'ANY', 'olderThan': '1209600s'}} if 'condition' in p else {'mostRecentVersions': p['mostRecentVersions']})} for p in policies}
    s['repos'][0]['cleanupPolicyDryRun'] = '--dry-run' in args
    save({})
if starts('artifacts', 'repositories', 'get-iam-policy'): save(s.get('repo_policy', {}))
if starts('iam', 'service-accounts', 'list'): save(s.get('accounts', []))
if starts('iam', 'service-accounts', 'create'):
    s.setdefault('accounts', []).append({'email': args[3] + '@test-project.iam.gserviceaccount.com'}); save({})
if starts('iam', 'service-accounts', 'keys', 'list'): save(s.get('keys', []))
if starts('projects', 'get-iam-policy'): save(s.get('project_policy', {}))
if starts('iam', 'workload-identity-pools', 'list'): save(s.get('pools', []))
if starts('iam', 'workload-identity-pools', 'create'):
    s['pools'] = [{'name': 'projects/123456789/locations/global/workloadIdentityPools/mfmf-github', 'state': 'ACTIVE'}]; save({})
if starts('iam', 'workload-identity-pools', 'providers', 'list'):
    if s.get('deny_provider_list'): sys.exit(1)
    s['provider_reads'] = s.get('provider_reads', 0) + 1
    if s.get('drift_before_update') and s['provider_reads'] == 2:
        s['providers'][0]['attributeCondition'] = 'true'
    save(s.get('providers', []))
if starts('iam', 'workload-identity-pools', 'providers', 'create-oidc'):
    s['providers'] = [{'name': 'projects/123456789/locations/global/workloadIdentityPools/mfmf-github/providers/github-main',
        'state': 'ACTIVE', 'oidc': {'issuerUri': opt('--issuer-uri')},
        'attributeCondition': opt('--attribute-condition'),
        'attributeMapping': dict(item.split('=', 1) for item in opt('--attribute-mapping').split(','))}]; save({})
if starts('iam', 'workload-identity-pools', 'providers', 'update-oidc'):
    s['providers'][0]['attributeCondition'] = opt('--attribute-condition')
    if s.get('tamper_after_update'): s['providers'][0]['displayName'] = 'Unexpected change'
    if s.get('condition_after_update'): s['providers'][0]['attributeCondition'] = s['condition_after_update']
    if s.get('deny_update'):
        state_path.write_text(json.dumps(s)); sys.exit(1)
    save({})
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
        elif script in ['configure-artifact-cleanup.sh', 'enable-production-wif.sh']:
            args += ['--project-number', '123456789']
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

    def wif_base(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        state = json.loads(self.state.read_text())
        state['provider_reads'] = 0
        self.state.write_text(json.dumps(state))
        self.log.unlink(missing_ok=True)
        return state

    def test_production_wif_plan_has_no_cloud_calls(self):
        result = self.invoke(apply=False, script='enable-production-wif.sh')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), [])

    def test_production_wif_changes_only_condition_once_and_bootstrap_accepts_it(self):
        before = self.wif_base()['providers'][0]
        result = self.invoke(script='enable-production-wif.sh')
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        updates = [c for c in calls if 'update-oidc' in c]
        self.assertEqual(len(updates), 1)
        update = updates[0]
        self.assertEqual(update[:5], ['iam', 'workload-identity-pools', 'providers', 'update-oidc', 'github-main'])
        flags = {arg.split('=', 1)[0] for arg in update[5:]}
        self.assertEqual(flags, {'--project', '--quiet', '--location', '--workload-identity-pool', '--attribute-condition'})
        self.assertIn('--project=test-project', update)
        self.assertIn('--location=global', update)
        self.assertIn('--workload-identity-pool=mfmf-github', update)
        self.assertEqual(sum(c[:4] == ['iam', 'workload-identity-pools', 'providers', 'list'] for c in calls), 3)
        self.assertFalse(any('add-iam-policy-binding' in c or 'create' in c or 'enable' in c or 'set-iam-policy' in c for c in calls))
        after = json.loads(self.state.read_text())['providers'][0]
        self.assertEqual({k: v for k, v in before.items() if k != 'attributeCondition'},
                         {k: v for k, v in after.items() if k != 'attributeCondition'})
        self.log.unlink()
        self.assertEqual(self.invoke(script='enable-production-wif.sh').returncode, 0)
        self.assertFalse(any('update-oidc' in c for c in self.calls()))
        self.log.unlink()
        self.assertEqual(self.invoke().returncode, 0)
        self.assertFalse(any('update-oidc' in c or 'create-oidc' in c for c in self.calls()))

    def test_production_wif_condition_keeps_claim_boundaries(self):
        self.wif_base()
        result = self.invoke(script='enable-production-wif.sh')
        self.assertEqual(result.returncode, 0, result.stderr)
        condition = json.loads(self.state.read_text())['providers'][0]['attributeCondition']
        claims = {'repository_id': '1271210275', 'repository_owner_id': '19723431',
                  'ref': 'refs/heads/main', 'event_name': 'push',
                  'workflow_ref': 'godhuu0505/mfmf/.github/workflows/deploy-production.yml@refs/heads/main'}

        def permits(overrides):
            values = {**claims, **overrides}
            # The policy uses only CEL equality, list membership and boolean operators.
            # Evaluate that restricted subset against fixture claims without external CEL/runtime calls.
            expression = re.sub(r'assertion\.([a-z_]+)', lambda m: json.dumps(values.get(m[1])), condition)
            expression = expression.replace('&&', ' and ').replace('||', ' or ')
            tree = ast.parse(expression, mode='eval')
            allowed = (ast.Expression, ast.BoolOp, ast.And, ast.Or, ast.Compare, ast.Eq,
                       ast.In, ast.Constant, ast.List, ast.Load)
            self.assertTrue(all(isinstance(node, allowed) for node in ast.walk(tree)))
            return eval(compile(tree, '<fixture-policy>', 'eval'), {'__builtins__': {}}, {})

        manual = 'godhuu0505/mfmf/.github/workflows/deploy-cloud-run.yml@refs/heads/main'
        self.assertTrue(permits({}))
        self.assertTrue(permits({'workflow_ref': manual, 'event_name': 'push'}))
        self.assertTrue(permits({'workflow_ref': manual, 'event_name': 'workflow_dispatch'}))
        for override in [
            {'event_name': 'workflow_dispatch'}, {'event_name': 'pull_request'},
            {'event_name': 'pull_request_target'}, {'event_name': 'workflow_call'}, {'event_name': 'schedule'},
            {'repository_id': '999'}, {'repository_owner_id': '999'},
            {'ref': 'refs/heads/other'}, {'ref': 'refs/pull/1/merge'}, {'ref': 'refs/tags/main'},
            {'workflow_ref': manual.replace('refs/heads/main', 'refs/heads/other')},
            {'workflow_ref': manual.replace('deploy-cloud-run.yml', 'other.yml')},
            {'workflow_ref': manual, 'event_name': 'pull_request_target'},
            {'workflow_ref': manual, 'repository_id': '999'},
            {'workflow_ref': manual, 'repository_owner_id': '999'},
            {'workflow_ref': manual, 'ref': 'refs/heads/other'},
        ]:
            with self.subTest(override=override): self.assertFalse(permits(override))

    def test_production_wif_refuses_unknown_or_changed_trust_before_update(self):
        base = self.wif_base()
        cases = []
        for field, value in [('attributeCondition', 'true'), ('attributeCondition', base['providers'][0]['attributeCondition'] + ' '),
                             ('state', 'DELETED'), ('disabled', True), ('name', 'projects/other/providers/github-main'),
                             ('attributeMapping', {'google.subject': 'assertion.sub'}), ('actorProviders', ['unexpected'])]:
            state = json.loads(json.dumps(base)); state['providers'][0][field] = value; cases.append(state)
        for field, value in [('issuerUri', 'https://evil.example'), ('allowedAudiences', ['unexpected']),
                             ('jwksJson', '{}'), ('discoveryUri', 'https://evil.example')]:
            state = json.loads(json.dumps(base)); state['providers'][0]['oidc'][field] = value; cases.append(state)
        for changed in [{'number': '999'}, {'pools': []}, {'providers': []}, {'deny_provider_list': True}, {'drift_before_update': True},
                        {'pools': 'PRIVATE_FIXTURE_NEVER_PRINT'}, {'providers': 'PRIVATE_FIXTURE_NEVER_PRINT'}]:
            state = json.loads(json.dumps(base)); state.update(changed); cases.append(state)
        state = json.loads(json.dumps(base)); state['providers'].append({**state['providers'][0], 'name': 'another-provider'}); cases.append(state)
        for state in cases:
            with self.subTest(state=state):
                self.state.write_text(json.dumps(state)); self.log.unlink(missing_ok=True)
                result = self.invoke(script='enable-production-wif.sh')
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('PRIVATE_FIXTURE', result.stdout + result.stderr)
                self.assertFalse(any('update-oidc' in c or 'add-iam-policy-binding' in c for c in self.calls()))

    def test_production_wif_failed_update_or_verification_does_not_retry_or_rollback(self):
        base = self.wif_base()
        for changed in [{'deny_update': True}, {'tamper_after_update': True}, {'condition_after_update': 'true'}]:
            with self.subTest(changed=changed):
                state = json.loads(json.dumps(base)); state.update(changed)
                self.state.write_text(json.dumps(state)); self.log.unlink(missing_ok=True)
                result = self.invoke(script='enable-production-wif.sh')
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(sum('update-oidc' in c for c in self.calls()), 1)
                self.assertFalse(any('add-iam-policy-binding' in c or 'set-iam-policy' in c or 'delete' in c for c in self.calls()))
    def test_cleanup_plan_simulation_and_apply(self):
        script = 'configure-artifact-cleanup.sh'
        self.assertEqual(self.invoke(apply=False, script=script).returncode, 0)
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.invoke().returncode, 0)
        self.log.unlink()
        self.assertNotEqual(self.invoke(script=script).returncode, 0)
        self.assertFalse(any('set-cleanup-policies' in c for c in self.calls()))
        dry = self.invoke(apply=False, script=script, extra=['--dry-run'])
        self.assertEqual(dry.returncode, 0, dry.stderr)
        live = self.invoke(script=script)
        self.assertEqual(live.returncode, 0, live.stderr)
        changes = [c for c in self.calls() if 'set-cleanup-policies' in c]
        self.assertEqual(len(changes), 2)
        self.assertTrue(all(c[3] == 'mfmf' and '--location=asia-northeast1' in c for c in changes))
        self.assertIn('--dry-run', changes[0])
        self.assertIn('--no-dry-run', changes[1])
        policies = json.loads(self.state.read_text())['repos'][0]['cleanupPolicies']
        self.assertEqual(policies['mfmf-keep-last-5']['mostRecentVersions']['keepCount'], 5)
        self.assertEqual(policies['mfmf-delete-after-14d']['condition']['olderThan'], '1209600s')
        self.assertFalse(any('delete' in c or 'delete-cleanup-policies' in c for c in self.calls()))

    def test_cleanup_refuses_other_repositories_and_existing_policies(self):
        self.assertEqual(self.invoke().returncode, 0)
        base = json.loads(self.state.read_text())
        cases = []
        for field, value in [('description', 'Other app'), ('name', 'projects/test-project/locations/asia-northeast1/repositories/other'), ('cleanupPolicies', {'keep-everything': {'action': 'KEEP'}})]:
            state = json.loads(json.dumps(base)); state['repos'][0][field] = value; cases.append(state)
        state = json.loads(json.dumps(base)); state['number'] = '999'; cases.append(state)
        for state in cases:
            with self.subTest(state=state):
                self.state.write_text(json.dumps(state)); self.log.unlink(missing_ok=True)
                self.assertNotEqual(self.invoke(apply=False, script='configure-artifact-cleanup.sh', extra=['--dry-run']).returncode, 0)
                self.assertFalse(any('set-cleanup-policies' in c for c in self.calls()))

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
