// /updates: turns on the "Update Cardlake" button in the owner's copy on
// GitHub. The Deploy button's copy is made without .github/workflows (Vercel
// can't write workflow files), so this opens GitHub's new-file page with the
// workflow filled in. public/update-cardlake.yml is the same file as
// .github/workflows/update-cardlake.yml (tests/unit/test_update_cardlake.py).
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const WORKFLOW_PATH = '.github/workflows/update-cardlake.yml';
  const REPO_NAME = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

  function turnOnLink(repo, branch, workflow) {
    const query = new URLSearchParams({ filename: WORKFLOW_PATH, value: workflow });
    return `https://github.com/${repo}/new/${encodeURIComponent(branch)}?${query}`;
  }

  function showSteps(repo, branch, workflow) {
    $('turn-on').href = turnOnLink(repo, branch, workflow);
    $('run-update').href = `https://github.com/${repo}/actions/workflows/update-cardlake.yml`;
    $('repo-form').hidden = true;
    $('steps').hidden = false;
  }

  async function start() {
    let instance, workflow;
    try {
      const res = await fetch('/api/auth/instance', { credentials: 'same-origin' });
      if (res.status === 401) { $('loading').hidden = true; $('signed-out').hidden = false; return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      instance = await res.json();
      const file = await fetch('/update-cardlake.yml');
      if (!file.ok) throw new Error(`HTTP ${file.status}`);
      workflow = await file.text();
    } catch (error) {
      $('loading').textContent = `Could not reach your Cardlake: ${error.message}. Reload to try again.`;
      return;
    }
    $('loading').hidden = true;
    $('ready').hidden = false;
    // Straight after setup (setup.html), this is its last step.
    if (new URLSearchParams(location.search).has('setup')) {
      document.querySelector('#ready h1').textContent = 'Last step: turn on updates';
      $('to-cards').textContent = 'Skip for now and go to my cards';
    }
    // Vercel says which repository this copy deploys from; anywhere else the
    // owner types it.
    const repository = instance.repository;
    if (repository && REPO_NAME.test(repository.full_name)) {
      showSteps(repository.full_name, repository.branch || 'main', workflow);
      return;
    }
    $('repo-form').hidden = false;
    $('repo-form').addEventListener('submit', event => {
      event.preventDefault();
      const repo = new FormData(event.target).get('repo').trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
      if (!REPO_NAME.test(repo)) { $('repo-error').textContent = 'Enter it as owner/name, like your-name/cardlake.'; return; }
      $('repo-error').textContent = '';
      showSteps(repo, 'main', workflow);
    });
  }

  start();
})();
