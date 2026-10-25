(() => {
  const body = document.body;
  const toggle = document.querySelector('.menu-toggle');
  const backdrop = document.querySelector('.sidebar-backdrop');
  const search = document.querySelector('#guide-search');
  const navItems = [...document.querySelectorAll('.nav-item')];
  const navGroups = [...document.querySelectorAll('[data-nav-group]')];
  const submenuLinks = [...document.querySelectorAll('.submenu a')];
  const submenuToggles = [...document.querySelectorAll('.submenu-toggle')];
  const tocCards = [...document.querySelectorAll('.path-card')];
  const empty = document.querySelector('#empty-search');
  const breadcrumbCurrent = document.querySelector('.breadcrumb strong');
  const sidebar = document.querySelector('.sidebar');
  const sidebarTools = document.querySelector('.sidebar-tools');
  const languageSelect = document.querySelector('#guide-language');
  const isEnglishGuide = document.documentElement.lang.toLowerCase().startsWith('en');
  const locale = isEnglishGuide ? 'en' : 'vi';
  const observedSections = [...document.querySelectorAll('#gioi-thieu, .chapter-intro[id], .section-block[id]')];

  // Cloudflare Pages serves `/guide/01-lam-quen.html` as `/guide/01-lam-quen` (and `index.html` as the
  // bare directory), so a page can never be identified by its raw URL. Every page comparison in this
  // file goes through these two helpers: `pageName` restores the file name, `pageKey` adds its folder
  // so a Vietnamese page and its English counterpart stay distinct.
  const pageName = (pathname) => {
    const last = pathname.split('/').pop() || 'index.html';
    return /\.[a-z0-9]+$/i.test(last) ? last : `${last}.html`;
  };
  const pageKey = (pathname) => `${pathname.slice(0, pathname.lastIndexOf('/') + 1)}${pageName(pathname)}`;
  const currentPageKey = pageKey(window.location.pathname);

  // A link to a section of THIS page becomes a plain fragment, so it scrolls in place instead of
  // reloading the page through the extensionless redirect.
  document.querySelectorAll('a[href]').forEach((link) => {
    const url = new URL(link.getAttribute('href'), window.location.href);
    if (url.hash && url.origin === window.location.origin && pageKey(url.pathname) === currentPageKey) {
      link.setAttribute('href', url.hash);
    }
  });

  languageSelect?.addEventListener('change', () => {
    const currentPage = pageName(window.location.pathname);
    const currentHash = window.location.hash || body.dataset.chapter || '#gioi-thieu';
    if (languageSelect.value === 'en' && !isEnglishGuide) {
      window.location.href = `en/${currentPage}${currentHash}`;
    } else if (languageSelect.value === 'vi' && isEnglishGuide) {
      window.location.href = `../${currentPage}${currentHash}`;
    }
  });

  const chapterForHash = (hash) => {
    const chapterOneSections = new Set([
      '#chapter-01',
      '#pham-vi-lam-viec',
      '#doi-tuong-cong-viec',
      '#doi-tuong-ke-hoach',
      '#quyen-va-trach-nhiem',
      '#vi-du-xuyen-suot'
    ]);
    const chapterTwoSections = new Set([
      '#chapter-02',
      '#dang-nhap',
      '#thanh-dieu-huong',
      '#chon-project-team',
      '#doc-trang-home',
      '#cong-cu-ca-nhan',
      '#xu-ly-truy-cap'
    ]);
    const chapterThreeSections = new Set([
      '#chapter-03',
      '#doc-backlog',
      '#tao-user-story',
      '#tao-defect',
      '#chon-team-owner',
      '#cap-nhat-work-item',
      '#xu-ly-backlog'
    ]);
    const chapterFourSections = new Set([
      '#chapter-04',
      '#hieu-luong-testing',
      '#mo-test-cases',
      '#tao-test-case',
      '#hoan-thien-test-case',
      '#ghi-test-result',
      '#doc-ket-qua-testing',
      '#quan-ly-test-case-type',
      '#xu-ly-testing'
    ]);
    const chapterFiveSections = new Set([
      '#chapter-05',
      '#doc-timeboxes',
      '#tao-iteration',
      '#lap-planned-velocity',
      '#gan-cong-viec-iteration',
      '#doi-iteration',
      '#trang-thai-iteration',
      '#xu-ly-iteration'
    ]);
    const chapterSixSections = new Set([
      '#chapter-06',
      '#mo-task-list',
      '#tao-task-con',
      '#giao-task',
      '#cap-nhat-task-state',
      '#cap-nhat-gio-task',
      '#bo-sung-task',
      '#xu-ly-task'
    ]);
    const chapterSevenSections = new Set([
      '#chapter-07',
      '#mo-quality-defect',
      '#tao-defect-quality',
      '#phan-loai-defect',
      '#vong-doi-defect',
      '#doc-team-status',
      '#kiem-tra-rollup',
      '#xu-ly-chat-luong-team'
    ]);
    const chapterEightSections = new Set([
      '#chapter-08',
      '#chon-dung-man-hinh',
      '#tao-release',
      '#tao-milestone',
      '#lien-ket-release-milestone',
      '#quan-ly-artifacts',
      '#doc-release-tracking',
      '#xu-ly-release-milestone'
    ]);
    const chapterNineSections = new Set([
      '#chapter-09',
      '#mo-portfolio-items',
      '#phan-biet-epic-feature',
      '#tao-cap-nhat-portfolio',
      '#doc-tien-do-portfolio',
      '#tao-capacity-plan',
      '#phan-bo-capacity',
      '#publish-capacity-plan',
      '#xu-ly-portfolio-capacity'
    ]);
    const chapterTenSections = new Set([
      '#chapter-10',
      '#chon-bao-cao',
      '#doc-iteration-burndown',
      '#doc-velocity',
      '#doc-team-capacity-report',
      '#hieu-pham-vi-du-lieu',
      '#kiem-tra-du-lieu-thieu',
      '#xu-ly-bao-cao'
    ]);
    const chapterElevenSections = new Set([
      '#chapter-11',
      '#mo-quan-tri-workspace',
      '#quan-ly-users',
      '#quan-ly-project',
      '#phan-quyen-project',
      '#quan-ly-team',
      '#doc-permission-model',
      '#xem-audit-log',
      '#xu-ly-quan-tri'
    ]);
    const chapterTwelveSections = new Set([
      '#chapter-12',
      '#viet-user-story',
      '#viet-defect'
    ]);

    if (chapterOneSections.has(hash)) return '#chapter-01';
    if (chapterTwoSections.has(hash)) return '#chapter-02';
    if (chapterThreeSections.has(hash)) return '#chapter-03';
    if (chapterFourSections.has(hash)) return '#chapter-04';
    if (chapterFiveSections.has(hash)) return '#chapter-05';
    if (chapterSixSections.has(hash)) return '#chapter-06';
    if (chapterSevenSections.has(hash)) return '#chapter-07';
    if (chapterEightSections.has(hash)) return '#chapter-08';
    if (chapterNineSections.has(hash)) return '#chapter-09';
    if (chapterTenSections.has(hash)) return '#chapter-10';
    if (chapterElevenSections.has(hash)) return '#chapter-11';
    if (chapterTwelveSections.has(hash)) return '#chapter-12';
    if (/^#chapter-(0[2-9]|1[0-2])$/.test(hash)) return hash;
    return '#gioi-thieu';
  };

  const pageForChapter = {
    '#gioi-thieu': 'index.html',
    '#chapter-01': '01-lam-quen.html',
    '#chapter-02': '02-truy-cap-pham-vi.html',
    '#chapter-03': '03-backlog-cong-viec.html',
    '#chapter-04': '04-testing.html',
    '#chapter-05': '05-lap-ke-hoach.html',
    '#chapter-06': '06-thuc-hien-cong-viec.html',
    '#chapter-07': '07-loi-theo-doi-team.html',
    '#chapter-08': '08-release-milestone.html',
    '#chapter-09': '09-portfolio-capacity.html',
    '#chapter-10': '10-bao-cao.html',
    '#chapter-11': '11-quan-tri-workspace.html',
    '#chapter-12': '12-viet-backlog-item.html'
  };
  const requestedHash = window.location.hash || body.dataset.chapter || '#gioi-thieu';
  const expectedPage = pageForChapter[chapterForHash(requestedHash)];
  const currentPage = pageName(window.location.pathname);

  if (expectedPage && currentPage !== expectedPage) {
    window.location.replace(`${expectedPage}${requestedHash}`);
    return;
  }

  const syncGroupButton = (group) => {
    const button = group.querySelector('.submenu-toggle');
    const title = group.querySelector('.nav-item strong')?.textContent?.trim() || (isEnglishGuide ? 'this chapter' : 'chương này');
    const isOpen = group.classList.contains('open');

    button?.setAttribute('aria-expanded', String(isOpen));
    button?.setAttribute(
      'aria-label',
      isEnglishGuide
        ? `${isOpen ? 'Collapse' : 'Open'} items in ${title}`
        : `${isOpen ? 'Thu gọn' : 'Mở'} các mục trong phần ${title}`
    );
  };

  const linkTarget = (link) => {
    const url = new URL(link.getAttribute('href') || '', window.location.href);
    return { hash: url.hash, isCurrentPage: pageKey(url.pathname) === currentPageKey };
  };

  const updateActiveChapter = (activeHash = window.location.hash || body.dataset.chapter || '#gioi-thieu') => {
    const activeHref = chapterForHash(activeHash);
    let activeItem;
    let activeSubmenu;

    navItems.forEach((item) => {
      const target = linkTarget(item);
      const isActive = target.hash === activeHref;
      item.classList.toggle('active', isActive);
      if (isActive) activeItem = item;
    });

    submenuLinks.forEach((link) => {
      const target = linkTarget(link);
      const isActive = target.isCurrentPage && target.hash === activeHash;
      link.classList.toggle('active', isActive);
      if (isActive) activeSubmenu = link;

      if (isActive) {
        const group = link.closest('[data-nav-group]');
        group?.classList.add('open');
        if (group) syncGroupButton(group);
      }
    });

    navGroups.forEach((group) => {
      const isActive = Boolean(group.querySelector('.nav-item.active'));
      group.classList.toggle('active', isActive);
      if (isActive) {
        group.classList.add('open');
      } else if (activeHref !== '#gioi-thieu') {
        group.classList.remove('open');
      }
      syncGroupButton(group);
    });

    if (breadcrumbCurrent && activeItem) {
      const number = activeItem.querySelector('.nav-number')?.textContent?.trim();
      const title = activeItem.querySelector('strong')?.textContent?.trim();
      breadcrumbCurrent.textContent = `${number}. ${title}`;
    }

    const visibleTarget = activeSubmenu || activeItem;
    if (sidebar && visibleTarget) {
      const sidebarRect = sidebar.getBoundingClientRect();
      const targetRect = visibleTarget.getBoundingClientRect();
      const safeTop = sidebarRect.top + (sidebarTools?.getBoundingClientRect().height || 0) + 40;
      if (targetRect.top < safeTop || targetRect.bottom > sidebarRect.bottom - 12) {
        sidebar.scrollTop += targetRect.top - safeTop;
      }
    }
  };

  const closeSidebar = () => {
    body.classList.remove('sidebar-open');
    toggle?.setAttribute('aria-expanded', 'false');
  };

  toggle?.addEventListener('click', () => {
    const isOpen = body.classList.toggle('sidebar-open');
    toggle.setAttribute('aria-expanded', String(isOpen));
  });

  backdrop?.addEventListener('click', closeSidebar);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSidebar();
  });

  submenuToggles.forEach((button) => button.addEventListener('click', () => {
    const group = button.closest('[data-nav-group]');
    group?.classList.toggle('open');
    if (group) syncGroupButton(group);
  }));

  navItems.forEach((item) => item.addEventListener('click', () => {
    const group = item.closest('[data-nav-group]');
    group?.classList.add('open');
    if (group) syncGroupButton(group);
    closeSidebar();
    window.setTimeout(updateActiveChapter, 0);
  }));

  submenuLinks.forEach((link) => link.addEventListener('click', () => {
    closeSidebar();
    window.setTimeout(updateActiveChapter, 0);
  }));

  window.addEventListener('hashchange', updateActiveChapter);
  window.addEventListener('load', () => {
    updateActiveChapter();
    // A page opened with no fragment has nothing to scroll to. `hash && querySelector(...)` yielded
    // '' there, and `''?.scrollIntoView()` throws (optional chaining only skips null/undefined), which
    // also cancelled the highlight refresh below. `getElementById` cannot throw on an odd fragment.
    const target = window.location.hash ? document.getElementById(decodeURIComponent(window.location.hash.slice(1))) : null;
    target?.scrollIntoView();
    window.setTimeout(updateActiveChapter, 120);
  });
  navGroups.forEach(syncGroupButton);
  updateActiveChapter();

  let scrollFrame;
  const updateActiveFromScroll = () => {
    scrollFrame = undefined;
    const readingLine = Math.min(window.innerHeight * 0.5, 360);
    let activeSection = observedSections[0];

    for (const section of observedSections) {
      if (section.getBoundingClientRect().top <= readingLine) {
        activeSection = section;
      } else {
        break;
      }
    }

    if (!activeSection) return;
    const activeHash = `#${activeSection.id}`;
    if (window.location.hash !== activeHash) {
      window.history.replaceState(null, '', activeHash);
    }
    updateActiveChapter(activeHash);
  };

  window.addEventListener('scroll', () => {
    if (scrollFrame !== undefined) return;
    scrollFrame = window.requestAnimationFrame(updateActiveFromScroll);
  }, { passive: true });

  search?.addEventListener('input', () => {
    const query = search.value.trim().toLocaleLowerCase(locale);
    let visibleCards = 0;

    navItems.filter((item) => !item.closest('[data-nav-group]')).forEach((item) => {
      const matches = !query || (item.dataset.search || item.textContent).toLocaleLowerCase(locale).includes(query);
      item.classList.toggle('filtered-out', !matches);
    });

    navGroups.forEach((group) => {
      const mainItem = group.querySelector('.nav-item');
      const groupSubmenuLinks = [...group.querySelectorAll('.submenu a')];
      const mainText = (mainItem?.dataset.search || mainItem?.textContent || '').toLocaleLowerCase(locale);
      const mainMatches = !query || mainText.includes(query);
      let submenuMatches = false;

      groupSubmenuLinks.forEach((link) => {
        const linkText = (link.dataset.search || link.textContent).toLocaleLowerCase(locale);
        const matches = !query || mainMatches || linkText.includes(query);
        link.classList.toggle('filtered-out', !matches);
        if (linkText.includes(query)) submenuMatches = true;
      });

      const groupMatches = !query || mainMatches || submenuMatches;
      group.classList.toggle('filtered-out', !groupMatches);
      if (query && groupMatches) group.classList.add('open');
      syncGroupButton(group);
    });

    tocCards.forEach((card) => {
      const matches = !query || (card.dataset.search || card.textContent).toLocaleLowerCase(locale).includes(query);
      card.classList.toggle('filtered-out', !matches);
      if (matches) visibleCards += 1;
    });

    if (empty) empty.hidden = visibleCards !== 0;
  });
})();
