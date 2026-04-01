      // ===== GitHub Pages: localStorage-backed API shim =====
      const ADMIN_PASSWORD = 'qwerty';
      const _db = {
        get users() { return JSON.parse(localStorage.getItem('h_users') || '[]'); },
        set users(v) { localStorage.setItem('h_users', JSON.stringify(v)); },
        get data() {
          const d = localStorage.getItem('h_data');
          return d ? JSON.parse(d) : null;
        },
        set data(v) { localStorage.setItem('h_data', JSON.stringify(v)); }
      };

      const _jsonRes = (body, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

      const _nextId = (arr) => arr.length ? Math.max(...arr.map(x => x.id)) + 1 : 1;

      const _origFetch = window.fetch.bind(window);

      // Always fetch data.json and merge with localStorage
      const _dataReady = (async () => {
        let serverData = null;
        try {
          const r = await _origFetch('data.json', { cache: 'no-cache' });
          if (r.ok) serverData = await r.json();
        } catch (e) { /* network error */ }

        const local = _db.data;
        if (!serverData && !local) {
          _db.data = { museums: [], artifacts: [] };
          return;
        }
        if (!serverData) return; // keep localStorage as-is if fetch failed
        if (!local) {
          _db.data = serverData;
          return;
        }

        // Merge: server data.json is source of truth for IDs that exist there;
        // keep local-only items (created in admin on GitHub Pages)
        const merged = { museums: [], artifacts: [] };

        // Server museums are canonical
        const serverMuseumIds = new Set(serverData.museums.map(m => m.id));
        merged.museums = [...serverData.museums];
        // Keep locally-created museums (IDs not in server data)
        for (const lm of local.museums || []) {
          if (!serverMuseumIds.has(lm.id)) merged.museums.push(lm);
        }

        // Server artifacts are canonical
        const serverArtifactIds = new Set(serverData.artifacts.map(a => a.id));
        merged.artifacts = [...serverData.artifacts];
        // Keep locally-created artifacts (IDs not in server data, e.g. with base64 images)
        for (const la of local.artifacts || []) {
          if (!serverArtifactIds.has(la.id) && String(la.image || '').startsWith('data:')) {
            merged.artifacts.push(la);
          }
        }

        _db.data = merged;
      })();

      window.fetch = async (url, opts = {}) => {
        if (typeof url !== 'string' || !url.startsWith('/api/')) return _origFetch(url, opts);
        await _dataReady; // ensure data.json is loaded before any API call
        const method = (opts.method || 'GET').toUpperCase();
        const path = url.split('?')[0];
        const params = new URLSearchParams(url.includes('?') ? url.split('?')[1] : '');
        const json = () => {
          if (opts.body && typeof opts.body === 'string') return JSON.parse(opts.body);
          return {};
        };

        // ---------- AUTH ----------
        if (path === '/api/register' && method === 'POST') {
          const { nickname, email, password } = json();
          if (!nickname) return _jsonRes({ error: 'Введите никнейм.' }, 400);
          if (!email || !email.includes('@')) return _jsonRes({ error: 'Проверьте корректность почты.' }, 400);
          if (!password || password.length < 8) return _jsonRes({ error: 'Пароль должен быть не меньше 8 символов и содержать только латинские буквы и цифры.' }, 400);
          const users = _db.users;
          if (users.some(u => u.nickname.toLowerCase() === nickname.toLowerCase())) return _jsonRes({ error: 'Никнейм уже занят.' }, 400);
          if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) return _jsonRes({ error: 'Аккаунт с такой почтой уже существует.' }, 400);
          const profile = { museums_completed: 0, artifacts_found: 0, rating: 0, coins: 0, email_masked: '***@***.com', two_factor_enabled: false };
          const user = { nickname, email, password, profile, inventory: { skins: [], items: [], achievements: [], rewards: [] }, artifact_failures: {} };
          users.push(user);
          _db.users = users;
          return _jsonRes({ success: true, profile, nickname, inventory: user.inventory });
        }

        if (path === '/api/login' && method === 'POST') {
          const { identity, password } = json();
          const users = _db.users;
          const id = (identity || '').toLowerCase();
          const user = users.find(u => u.nickname.toLowerCase() === id || u.email.toLowerCase() === id);
          if (!user) return _jsonRes({ error: 'Пользователь не найден.' }, 400);
          if (user.password !== password) return _jsonRes({ error: 'Неверный пароль.' }, 400);
          if (user.profile && !('coins' in user.profile)) user.profile.coins = 0;
          return _jsonRes({ success: true, nickname: user.nickname, profile: user.profile, inventory: _resolveInv(user) });
        }

        if (path === '/api/admin/login' && method === 'POST') {
          const { password } = json();
          if (password !== ADMIN_PASSWORD) return _jsonRes({ error: 'Неверный пароль администратора.' }, 400);
          return _jsonRes({ success: true });
        }

        // ---------- DATA ----------
        if (path === '/api/admin/data') {
          return _jsonRes(_db.data || { museums: [], artifacts: [] });
        }

        if (path === '/api/admin/users') {
          return _jsonRes((_db.users || []).map(u => ({ nickname: u.nickname })));
        }

        if (path === '/api/admin/give-item' && method === 'POST') {
          const PRICES = { common: 50, rare: 100, epic: 250, leg: 500, legendary: 500 };
          const { nickname, type, item_id, amount } = json();
          const users = _db.users;
          const user = users.find(u => u.nickname === nickname);
          if (!user) return _jsonRes({ error: 'Пользователь не найден.' }, 404);
          if (type === 'artifact') {
            const data = _db.data || { artifacts: [] };
            const art = data.artifacts.find(a => a.id === item_id);
            if (!art) return _jsonRes({ error: 'Артефакт не найден.' }, 404);
            if ((user.inventory?.items || []).includes(item_id)) return _jsonRes({ error: 'Артефакт уже в инвентаре.' }, 400);
            user.inventory = user.inventory || { skins: [], items: [], achievements: [], rewards: [] };
            user.inventory.items.push(item_id);
            user.profile.artifacts_found = (user.profile.artifacts_found || 0) + 1;
          } else if (type === 'coins') {
            const amt = parseInt(amount) || 0;
            if (amt <= 0) return _jsonRes({ error: 'Количество должно быть > 0.' }, 400);
            user.profile.coins = (user.profile.coins || 0) + amt;
          } else {
            return _jsonRes({ error: 'Неизвестный тип.' }, 400);
          }
          _db.users = users;
          return _jsonRes({ success: true });
        }

        if (path === '/api/museums') {
          return _jsonRes((_db.data || { museums: [] }).museums);
        }

        // ---------- MUSEUMS CRUD ----------
        if (path === '/api/admin/museums' && method === 'POST') {
          const data = _db.data;
          const fd = opts.body instanceof FormData ? opts.body : new FormData();
          const museum = {
            id: _nextId(data.museums),
            name: fd.get('name') || '',
            address: fd.get('address') || '',
            city: fd.get('city') || '',
            description: fd.get('description') || '',
            coordinates: fd.get('coordinates') || '',
            latitude: 0, longitude: 0,
            artifacts: [], image: '', map_image: ''
          };
          const coords = museum.coordinates.split(',').map(Number);
          if (coords.length === 2) { museum.latitude = coords[0]; museum.longitude = coords[1]; }
          const imgFile = fd.get('image');
          if (imgFile && imgFile.size) {
            museum.image = await _fileToDataUrl(imgFile);
          }
          const mapFile = fd.get('map_image');
          if (mapFile && mapFile.size) {
            museum.map_image = await _fileToDataUrl(mapFile);
          }
          data.museums.push(museum);
          _db.data = data;
          return _jsonRes({ success: true, museum });
        }

        const museumMatch = path.match(/^\/api\/admin\/museums\/(\d+)$/);
        if (museumMatch) {
          const mid = parseInt(museumMatch[1]);
          const data = _db.data;
          if (method === 'DELETE') {
            data.museums = data.museums.filter(m => m.id !== mid);
            data.artifacts = data.artifacts.filter(a => a.museum_id !== mid);
            _db.data = data;
            return _jsonRes({ success: true });
          }
          if (method === 'PUT') {
            const museum = data.museums.find(m => m.id === mid);
            if (!museum) return _jsonRes({ error: 'Музей не найден.' }, 404);
            const fd = opts.body instanceof FormData ? opts.body : new FormData();
            if (fd.get('name')) museum.name = fd.get('name');
            if (fd.get('address')) museum.address = fd.get('address');
            if (fd.get('city')) museum.city = fd.get('city');
            if (fd.get('description')) museum.description = fd.get('description');
            if (fd.get('coordinates')) {
              museum.coordinates = fd.get('coordinates');
              const c = museum.coordinates.split(',').map(Number);
              if (c.length === 2) { museum.latitude = c[0]; museum.longitude = c[1]; }
            }
            const imgFile = fd.get('image');
            if (imgFile && imgFile.size) museum.image = await _fileToDataUrl(imgFile);
            const mapFile = fd.get('map_image');
            if (mapFile && mapFile.size) museum.map_image = await _fileToDataUrl(mapFile);
            _db.data = data;
            return _jsonRes({ success: true, museum });
          }
        }

        // ---------- ARTIFACTS CRUD ----------
        if (path === '/api/admin/artifacts' && method === 'POST') {
          const data = _db.data;
          const fd = opts.body instanceof FormData ? opts.body : new FormData();
          const artifact = {
            id: _nextId(data.artifacts),
            name: fd.get('name') || '',
            museum_id: parseInt(fd.get('museum_id')) || 0,
            difficulty: fd.get('difficulty') || 'common',
            minigame: fd.get('minigame') || 'words',
            map_x: parseFloat(fd.get('map_x')) || 50,
            map_y: parseFloat(fd.get('map_y')) || 50,
            image: ''
          };
          const qData = fd.get('quiz_questions');
          if (qData) try { artifact.quiz_questions = JSON.parse(qData); } catch(e) {}
          const wData = fd.get('words_data');
          if (wData) try { artifact.words_data = JSON.parse(wData); } catch(e) {}
          const imgFile = fd.get('image');
          if (imgFile && imgFile.size) artifact.image = await _fileToDataUrl(imgFile);
          const modelFile = fd.get('model_3d');
          if (modelFile && modelFile.size) artifact.model_3d = await _fileToDataUrl(modelFile);
          // Super Quiz fields
          if (artifact.minigame === 'super_quiz') {
            const sqBg = fd.get('sq_bg');
            if (sqBg && sqBg.size) artifact.sq_bg = await _fileToDataUrl(sqBg);
            const sqMusic = fd.get('sq_music');
            if (sqMusic && sqMusic.size) artifact.sq_music = await _fileToDataUrl(sqMusic);
            const sqChar = fd.get('sq_character');
            if (sqChar && sqChar.size) artifact.sq_character = await _fileToDataUrl(sqChar);
            if (fd.get('sq_character_name')) artifact.sq_character_name = fd.get('sq_character_name');
            const sqQ = fd.get('sq_questions');
            if (sqQ) try { artifact.sq_questions = JSON.parse(sqQ); } catch(e) {}
          }
          data.artifacts.push(artifact);
          const museum = data.museums.find(m => m.id === artifact.museum_id);
          if (museum) { if (!museum.artifacts) museum.artifacts = []; museum.artifacts.push(artifact.id); }
          _db.data = data;
          return _jsonRes({ success: true, artifact });
        }

        const artMatch = path.match(/^\/api\/admin\/artifacts\/(\d+)$/);
        if (artMatch) {
          const aid = parseInt(artMatch[1]);
          const data = _db.data;
          if (method === 'DELETE') {
            data.artifacts = data.artifacts.filter(a => a.id !== aid);
            data.museums.forEach(m => { if (m.artifacts) m.artifacts = m.artifacts.filter(id => id !== aid); });
            _db.data = data;
            return _jsonRes({ success: true });
          }
          if (method === 'PUT') {
            const artifact = data.artifacts.find(a => a.id === aid);
            if (!artifact) return _jsonRes({ error: 'Артефакт не найден.' }, 404);
            const fd = opts.body instanceof FormData ? opts.body : new FormData();
            if (fd.get('name')) artifact.name = fd.get('name');
            if (fd.get('museum_id')) artifact.museum_id = parseInt(fd.get('museum_id'));
            if (fd.get('difficulty')) artifact.difficulty = fd.get('difficulty');
            if (fd.get('minigame')) artifact.minigame = fd.get('minigame');
            if (fd.get('map_x')) artifact.map_x = parseFloat(fd.get('map_x'));
            if (fd.get('map_y')) artifact.map_y = parseFloat(fd.get('map_y'));
            const qd = fd.get('quiz_questions');
            if (qd) try { artifact.quiz_questions = JSON.parse(qd); } catch(e) {}
            const wd = fd.get('words_data');
            if (wd) try { artifact.words_data = JSON.parse(wd); } catch(e) {}
            const imgFile = fd.get('image');
            if (imgFile && imgFile.size) artifact.image = await _fileToDataUrl(imgFile);
            const modelFile = fd.get('model_3d');
            if (modelFile && modelFile.size) artifact.model_3d = await _fileToDataUrl(modelFile);
            // Super Quiz fields (update)
            if ((fd.get('minigame') || artifact.minigame) === 'super_quiz') {
              const sqBg = fd.get('sq_bg');
              if (sqBg && sqBg.size) artifact.sq_bg = await _fileToDataUrl(sqBg);
              const sqMusic = fd.get('sq_music');
              if (sqMusic && sqMusic.size) artifact.sq_music = await _fileToDataUrl(sqMusic);
              const sqChar = fd.get('sq_character');
              if (sqChar && sqChar.size) artifact.sq_character = await _fileToDataUrl(sqChar);
              if (fd.get('sq_character_name')) artifact.sq_character_name = fd.get('sq_character_name');
              const sqQ = fd.get('sq_questions');
              if (sqQ) try { artifact.sq_questions = JSON.parse(sqQ); } catch(e) {}
            }
            _db.data = data;
            return _jsonRes({ success: true, artifact });
          }
        }

        // ---------- PROFILE ----------
        if (path === '/api/profile/avatar' && method === 'POST') {
          const fd = opts.body instanceof FormData ? opts.body : new FormData();
          const nickname = fd.get('nickname');
          const file = fd.get('avatar');
          if (!nickname || !file) return _jsonRes({ error: 'Ошибка.' }, 400);
          const users = _db.users;
          const user = users.find(u => u.nickname === nickname);
          if (!user) return _jsonRes({ error: 'Пользователь не найден.' }, 404);
          const dataUrl = await _fileToDataUrl(file);
          user.profile.avatar = dataUrl;
          _db.users = users;
          return _jsonRes({ success: true, avatar: dataUrl });
        }

        // ---------- INVENTORY ----------
        if (path === '/api/inventory') {
          const nickname = params.get('nickname');
          const users = _db.users;
          const user = users.find(u => u.nickname === nickname);
          if (!user) return _jsonRes({ error: 'Пользователь не найден.' }, 404);
          return _jsonRes(_resolveInv(user));
        }

        // ---------- ARTIFACT STATUS ----------
        if (path === '/api/artifact-status') {
          const artId = parseInt(params.get('artifact_id'));
          const nickname = params.get('nickname');
          const users = _db.users;
          const user = users.find(u => u.nickname === nickname);
          if (!user) return _jsonRes({ owned: false, failures: 0 });
          const owned = (user.inventory?.items || []).includes(artId);
          const failures = (user.artifact_failures || {})[String(artId)] || 0;
          return _jsonRes({ owned, failures });
        }

        // ---------- QUIZ / MINIGAMES ----------
        if (path === '/api/quiz-check' && method === 'POST') {
          const { artifact_id, nickname, answers } = json();
          const data = _db.data;
          const artifact = data.artifacts.find(a => a.id === artifact_id);
          if (!artifact) return _jsonRes({ error: 'Артефакт не найден.' }, 404);
          const questions = artifact.quiz_questions || [];
          let correct = 0;
          questions.forEach((q, i) => {
            const ua = (answers[i] || '').trim().toLowerCase();
            const ca = (q.correct_answer || q.answer || '').trim().toLowerCase();
            if (ua === ca) correct++;
          });
          const passed = correct >= Math.ceil(questions.length * 0.7);
          const users = _db.users;
          const user = users.find(u => u.nickname === nickname);
          if (user) {
            if (passed) {
              if (!user.inventory.items.includes(artifact_id)) {
                user.inventory.items.push(artifact_id);
                user.profile.artifacts_found++;
              }
              if (user.artifact_failures) delete user.artifact_failures[String(artifact_id)];
            } else {
              if (!user.artifact_failures) user.artifact_failures = {};
              user.artifact_failures[String(artifact_id)] = (user.artifact_failures[String(artifact_id)] || 0) + 1;
            }
            _db.users = users;
          }
          return _jsonRes({ passed, correct, total: questions.length });
        }

        if (path === '/api/superquiz-check' && method === 'POST') {
          const { artifact_id, nickname, answers } = json();
          const data = _db.data;
          const artifact = data.artifacts.find(a => a.id === artifact_id);
          if (!artifact) return _jsonRes({ error: 'Артефакт не найден.' }, 404);
          const steps = artifact.sq_questions || [];
          const answerable = steps.filter(s => s.type === 'test' || s.type === 'open');
          let correct = 0;
          (answers || []).forEach(ans => {
            const idx = ans.step_index;
            if (idx >= 0 && idx < steps.length) {
              const step = steps[idx];
              const ua = (ans.answer || '').trim().toLowerCase();
              if (step.type === 'test' && ua === (step.correct_answer || '').trim().toLowerCase()) correct++;
              if (step.type === 'open' && ua === (step.answer || '').trim().toLowerCase()) correct++;
            }
          });
          const total = answerable.length;
          const passed = correct >= Math.max(1, Math.ceil(total * 0.8));
          const users = _db.users;
          const user = users.find(u => u.nickname === nickname);
          if (user) {
            if (passed) {
              user.inventory = user.inventory || { skins: [], items: [], achievements: [], rewards: [] };
              user.inventory.rewards = user.inventory.rewards || [];
              if (!user.inventory.rewards.includes(artifact_id)) user.inventory.rewards.push(artifact_id);
              if (!user.inventory.items.includes(artifact_id)) {
                user.inventory.items.push(artifact_id);
                user.profile.artifacts_found++;
              }
              if (user.artifact_failures) delete user.artifact_failures[String(artifact_id)];
            } else {
              if (!user.artifact_failures) user.artifact_failures = {};
              user.artifact_failures[String(artifact_id)] = Date.now();
            }
            _db.users = users;
          }
          return _jsonRes({ success: true, passed, correct, total });
        }

        if ((path === '/api/words-complete' || path === '/api/flappy-complete' || path === '/api/piano-complete') && method === 'POST') {
          const { artifact_id, nickname } = json();
          const users = _db.users;
          const user = users.find(u => u.nickname === nickname);
          if (!user) return _jsonRes({ error: 'Пользователь не найден.' }, 404);
          if (!user.inventory.items.includes(artifact_id)) {
            user.inventory.items.push(artifact_id);
            user.profile.artifacts_found++;
          }
          if (user.artifact_failures) delete user.artifact_failures[String(artifact_id)];
          _db.users = users;
          return _jsonRes({ success: true, passed: true });
        }

        // ---------- SELL ARTIFACT ----------
        if (path === '/api/sell-artifact' && method === 'POST') {
          const PRICES = { common: 50, rare: 100, epic: 250, leg: 500, legendary: 500 };
          const { artifact_id, nickname } = json();
          const users = _db.users;
          const user = users.find(u => u.nickname === nickname);
          if (!user) return _jsonRes({ error: 'Пользователь не найден.' }, 404);
          const idx = (user.inventory?.items || []).indexOf(artifact_id);
          if (idx === -1) return _jsonRes({ error: 'Артефакт не в инвентаре.' }, 400);
          const data = _db.data || { artifacts: [] };
          const art = data.artifacts.find(a => a.id === artifact_id);
          if (!art) return _jsonRes({ error: 'Артефакт не найден.' }, 404);
          const diff = (art.difficulty || '').toLowerCase();
          if (diff === 'unique') return _jsonRes({ error: 'Уникальные артефакты нельзя продать.' }, 400);
          if (diff === 'trophy') return _jsonRes({ error: 'Трофейные артефакты нельзя продать.' }, 400);
          const price = PRICES[diff] || 0;
          if (price <= 0) return _jsonRes({ error: 'Этот артефакт нельзя продать.' }, 400);
          user.inventory.items.splice(idx, 1);
          user.profile.artifacts_found = Math.max(0, (user.profile.artifacts_found || 0) - 1);
          user.profile.coins = (user.profile.coins || 0) + price;
          _db.users = users;
          return _jsonRes({ success: true, coins: user.profile.coins, price });
        }

        // ---------- LEADERBOARD ----------
        if (path === '/api/leaderboard') {
          const city = params.get('city') || '';
          const users = _db.users;
          const data = _db.data || { museums: [], artifacts: [] };
          let board;
          if (city) {
            const mids = new Set(data.museums.filter(m => (m.city || '').toLowerCase() === city.toLowerCase()).map(m => m.id));
            const aids = new Set(data.artifacts.filter(a => mids.has(a.museum_id)).map(a => a.id));
            board = users.map(u => ({ nickname: u.nickname, avatar: u.profile?.avatar, artifacts: (u.inventory?.items || []).filter(id => aids.has(id)).length })).filter(e => e.artifacts > 0);
          } else {
            board = users.map(u => ({ nickname: u.nickname, avatar: u.profile?.avatar, artifacts: u.profile?.artifacts_found || 0 }));
          }
          board.sort((a, b) => b.artifacts - a.artifacts);
          board.forEach((e, i) => e.rank = i + 1);
          return _jsonRes(board);
        }

        // ---------- SHOP ----------
        if (path === '/api/admin/shop/banners') {
          try {
            const r = await _origFetch('shop.json', { cache: 'no-cache' });
            if (r.ok) { const d = await r.json(); return _jsonRes(d.banners || []); }
          } catch(e){}
          return _jsonRes([]);
        }

        if (path === '/api/admin/shop/frames') {
          try {
            const r = await _origFetch('shop.json', { cache: 'no-cache' });
            if (r.ok) { const d = await r.json(); return _jsonRes(d.frames || []); }
          } catch(e){}
          return _jsonRes([]);
        }

        if (path === '/api/shop/buy' && method === 'POST') {
          const { item_id, item_type, nickname } = json();
          const users = _db.users;
          const user = users.find(u => u.nickname === nickname);
          if (!user) return _jsonRes({ error: 'Пользователь не найден.' }, 404);
          let shopData;
          try {
            const r = await _origFetch('shop.json', { cache: 'no-cache' });
            shopData = await r.json();
          } catch(e) { return _jsonRes({ error: 'Магазин недоступен.' }, 500); }
          const items = item_type === 'banner' ? shopData.banners : shopData.frames;
          const item = (items || []).find(i => i.id === item_id);
          if (!item) return _jsonRes({ error: 'Товар не найден.' }, 404);
          const coins = user.profile.coins || 0;
          if (coins < item.price) return _jsonRes({ error: 'Недостаточно монет.' }, 400);
          user.inventory = user.inventory || { skins: [], items: [], achievements: [], rewards: [] };
          const key = item_type === 'banner' ? 'banners' : 'frames';
          user.inventory[key] = user.inventory[key] || [];
          if (user.inventory[key].includes(item_id)) return _jsonRes({ error: 'Уже куплено.' }, 400);
          user.inventory[key].push(item_id);
          user.profile.coins -= item.price;
          _db.users = users;
          return _jsonRes({ success: true, coins: user.profile.coins });
        }

        if (path === '/api/shop/equip' && method === 'POST') {
          const { item_id, item_type, nickname } = json();
          const users = _db.users;
          const user = users.find(u => u.nickname === nickname);
          if (!user) return _jsonRes({ error: 'Пользователь не найден.' }, 404);
          if (item_type === 'banner') user.profile.equipped_banner = item_id || '';
          else user.profile.equipped_frame = item_id || '';
          _db.users = users;
          return _jsonRes({ success: true });
        }

        // ---------- COLLECTIONS ----------
        if (path === '/api/collections') {
          try {
            const r = await _origFetch('collections.json', { cache: 'no-cache' });
            if (r.ok) return new Response(await r.text(), { status: 200, headers: { 'Content-Type': 'application/json' } });
          } catch(e){}
          return _jsonRes([]);
        }

        // ---------- ACHIEVEMENTS ----------
        if (path === '/api/achievements') {
          const nickname = params.get('nickname');
          const users = _db.users;
          const user = users.find(u => u.nickname === nickname);
          if (!user) return _jsonRes({ error: 'Пользователь не найден.' }, 404);
          return _jsonRes(user.inventory?.achievements || []);
        }

        // ---------- CHANGE PASSWORD ----------
        if (path === '/api/change-password' && method === 'POST') {
          const { nickname, old_password, new_password } = json();
          const users = _db.users;
          const user = users.find(u => u.nickname === nickname);
          if (!user) return _jsonRes({ error: 'Пользователь не найден.' }, 404);
          if (user.password !== old_password) return _jsonRes({ error: 'Неверный старый пароль.' }, 400);
          if (!new_password || new_password.length < 8) return _jsonRes({ error: 'Новый пароль должен быть не менее 8 символов.' }, 400);
          user.password = new_password;
          _db.users = users;
          return _jsonRes({ success: true });
        }

        // ---------- EMAIL ----------
        if (path === '/api/change-email' && method === 'POST') {
          const { nickname, new_email } = json();
          const users = _db.users;
          const user = users.find(u => u.nickname === nickname);
          if (!user) return _jsonRes({ error: 'Пользователь не найден.' }, 404);
          user.email = new_email;
          user.profile.email_masked = new_email.replace(/^(.{2}).*(@.*)$/, '$1***$2');
          _db.users = users;
          return _jsonRes({ success: true, email_masked: user.profile.email_masked });
        }

        // ---------- Claim / Cooldown ----------
        if (path === '/api/claim-artifact' && method === 'POST') {
          const { artifact_id, nickname } = json();
          const users = _db.users;
          const user = users.find(u => u.nickname === nickname);
          if (!user) return _jsonRes({ error: 'Пользователь не найден.' }, 404);
          user.inventory = user.inventory || { skins: [], items: [], achievements: [], rewards: [] };
          if (!user.inventory.items.includes(artifact_id)) {
            user.inventory.items.push(artifact_id);
            user.profile.artifacts_found++;
          }
          _db.users = users;
          return _jsonRes({ success: true });
        }

        // Fallback
        return _origFetch(url, opts);
      };

      const _resolveInv = (user) => {
        const data = _db.data || { artifacts: [], museums: [] };
        const museumsMap = {};
        (data.museums || []).forEach(m => { museumsMap[m.id] = m; });
        const items = (user.inventory?.items || []).map(id => {
          const art = data.artifacts.find(a => a.id === id);
          if (!art) return { id, name: 'Артефакт #' + id, image: '', difficulty: 'common', model_3d: '', museum_name: '' };
          const museum = museumsMap[art.museum_id];
          return { id: art.id, name: art.name, image: art.image, difficulty: art.difficulty, model_3d: art.model_3d || '', museum_name: museum ? museum.name : '' };
        });
        const rewards = (user.inventory?.rewards || []).map(id => {
          const art = data.artifacts.find(a => a.id === id);
          if (!art) return { id, name: 'Артефакт #' + id, image: '', difficulty: 'trophy', museum_name: '' };
          const museum = museumsMap[art.museum_id];
          return { id: art.id, name: art.name, image: art.image, difficulty: art.difficulty, museum_name: museum ? museum.name : '' };
        });
        return {
          skins: user.inventory?.skins || [],
          items,
          achievements: user.inventory?.achievements || [],
          rewards,
          banners: user.inventory?.banners || [],
          frames: user.inventory?.frames || [],
          equipped_banner: user.profile?.equipped_banner || '',
          equipped_frame: user.profile?.equipped_frame || ''
        };
      };

      const _fileToDataUrl = (file) => new Promise((resolve) => {
        if (!file || !file.size) { resolve(''); return; }
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve('');
        reader.readAsDataURL(file);
      });
      // ===== End API shim =====
