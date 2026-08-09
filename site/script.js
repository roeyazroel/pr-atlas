(() => {
  const productShot = document.querySelector('.product-shot');
  const productFallback = document.querySelector('.product-fallback');

  // Keep the polished, CSS-rendered product frame until a real capture is bundled.
  if (productShot && productFallback) {
    const showCapture = () => {
      if (!productShot.naturalWidth) return;
      productShot.classList.add('is-ready');
      productFallback.classList.add('is-hidden');
    };
    productShot.addEventListener('load', showCapture);
    productShot.addEventListener('error', () => {
      productShot.classList.remove('is-ready');
      productFallback.classList.remove('is-hidden');
    });
    if (productShot.complete) showCapture();
  }

  const flowDetails = [
    {
      type: 'INPUT',
      icon: '⌘',
      title: 'Start with the context you already trust.',
      body: 'PR Atlas reuses your authenticated GitHub CLI session for read-oriented discovery. No account, OAuth flow, or personal-token store is introduced.',
      code: 'gh pr view 482 --repo runway/atlas',
    },
    {
      type: 'CHECKOUT',
      icon: '⌂',
      title: 'Give the analysis its own safe workspace.',
      body: 'The application fetches the base and head into a managed clone/worktree, so your current branch and working tree stay untouched.',
      code: 'worktree: app-managed / read-only',
    },
    {
      type: 'CONSENT',
      icon: '◎',
      title: 'Choose the runtime. See the boundary.',
      body: 'Select Codex CLI, Cursor Agent, or Claude Code and a model the tool reports. Repository context is sent only after the provider-specific confirmation.',
      code: 'provider: codex · mode: read-only',
    },
    {
      type: 'VALIDATION',
      icon: '✓',
      title: 'Trust the shape before you trust the summary.',
      body: 'PR Atlas validates schema version, pull-request identity, base/head SHAs, evidence paths, graph relationships, and review-thread coverage before saving.',
      code: 'review.json · valid',
    },
    {
      type: 'REVIEW',
      icon: '↗',
      title: 'Make the call with the whole change in view.',
      body: 'Follow logical changes, flows, tests, and review attention in a fixed UI. The final approval decision remains with the human reviewer.',
      code: 'human judgment: required',
    },
  ];
  const flowDetail = document.querySelector('#flow-detail');
  const flowSteps = [...document.querySelectorAll('.flow-step')];
  const updateFlow = (index) => {
    const detail = flowDetails[index];
    if (!detail || !flowDetail) return;
    const label = flowDetail.querySelector('.flow-detail-label');
    const icon = flowDetail.querySelector('.flow-icon');
    const title = flowDetail.querySelector('h3');
    const body = flowDetail.querySelector('p');
    const code = flowDetail.querySelector('.flow-code');
    if (label) label.textContent = `STEP ${String(index + 1).padStart(2, '0')} / ${detail.type}`;
    if (icon) icon.textContent = detail.icon;
    if (title) title.textContent = detail.title;
    if (body) body.textContent = detail.body;
    if (code) code.innerHTML = `<span>$</span> ${detail.code}`;
    flowSteps.forEach((step, stepIndex) => {
      const active = stepIndex === index;
      step.classList.toggle('is-active', active);
      step.setAttribute('aria-pressed', String(active));
    });
  };
  flowSteps.forEach((step) => step.addEventListener('click', () => updateFlow(Number(step.dataset.step))));

  // Reveal sections as they enter the viewport. Everything remains visible without JS.
  const revealItems = [...document.querySelectorAll('.reveal')];
  if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.documentElement.classList.add('motion-ready');
    const observer = new IntersectionObserver((entries, instance) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        instance.unobserve(entry.target);
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -30px' });
    revealItems.forEach((item) => observer.observe(item));
  } else {
    revealItems.forEach((item) => item.classList.add('is-visible'));
  }
})();
