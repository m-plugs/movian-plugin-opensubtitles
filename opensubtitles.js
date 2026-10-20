(function (plugin) {

    // ── Manifest & modules ────────────────────────────────────────────────────
    var manifest = JSON.parse(Plugin.manifest);
    var TAG      = manifest.id || 'opensubtitles';
    var BASE_URL = 'https://api.opensubtitles.com/api/v1';
    var APP_NAME = (manifest.title || 'OpenSubtitles') + ' v' + (manifest.version || '1.1');

    var http      = require('movian/http');
    var settings = require('movian/settings');
    var subtitles = require('movian/subtitles');

    // ── Runtime config (filled from settings) ─────────────────────────────────
    var cfg = {
        apiKey:   '',
        username: '',
        password: '',
        maxResults: 20,
        preferHI: false,   // prefer hearing-impaired tracks
        debug:    false
    };

    // ── Logging ───────────────────────────────────────────────────────────────
    function log(msg) {
        showtime.trace(msg, TAG);
    }

    function debug(msg) {
        if (cfg.debug) log(msg);
    }

    // ── Settings ──────────────────────────────────────────────────────────────
    settings.globalSettings(manifest.id, manifest.title,
        Plugin.path + (manifest.icon || 'logo.png'),
        manifest.synopsis || '');

    settings.createInfo('info', Plugin.path + (manifest.icon || 'logo.png'),
        'Get a free API key at https://www.opensubtitles.com/en/consumers\n' +
        'Optional login raises the daily download quota (5 → 20+).');

    settings.createDivider('Credentials');

    settings.createString('apiKey', 'API Key', '', function (v) {
        cfg.apiKey = (v || '').trim();
        _token = null; // force re-auth if key changes
    });

    settings.createString('username', 'Username (optional)', '', function (v) {
        cfg.username = (v || '').trim();
        _token = null;
    });

    settings.createString('password', 'Password (optional)', '', function (v) {
        cfg.password = (v || '').trim();
        _token = null;
    });

    settings.createDivider('Search');

    settings.createInt('maxResults', 'Max results to register', 20, 1, 50, 1, function (v) {
        cfg.maxResults = v || 20;
    });

    settings.createBool('preferHI', 'Prefer hearing-impaired', false, function (v) {
        cfg.preferHI = !!v;
    });

    settings.createBool('debug', 'Debug logging', false, function (v) {
        cfg.debug = !!v;
    });

    // ── HTTP helpers ──────────────────────────────────────────────────────────
    function apiGet(path, args) {
        if (!cfg.apiKey) {
            log('API Key is not set — configure it in Settings → OpenSubtitles');
            return null;
        }
        var r = http.request(BASE_URL + path, {
            args:        args || {},
            headers:     {
                'Api-Key':    cfg.apiKey,
                'User-Agent': APP_NAME,
                'Accept':     'application/json'
            },
            noFail:      true,
            compression: true
        });
        try {
            return JSON.parse(r.toString());
        } catch (e) {
            log('apiGet parse error: ' + e);
            return null;
        }
    }

    function apiPost(path, body, token) {
        if (!cfg.apiKey) {
            log('API Key is not set — configure it in Settings → OpenSubtitles');
            return null;
        }
        var headers = {
            'Api-Key':      cfg.apiKey,
            'User-Agent':   APP_NAME,
            'Content-Type': 'application/json',
            'Accept':       'application/json'
        };
        if (token) headers['Authorization'] = 'Bearer ' + token;

        var r = http.request(BASE_URL + path, {
            postdata: body,
            headers:  headers,
            noFail:   true
        });
        try {
            return JSON.parse(r.toString());
        } catch (e) {
            log('apiPost parse error: ' + e);
            return null;
        }
    }

    // ── Auth (optional, raises download quota) ────────────────────────────────
    var _token = null;

    function getToken() {
        if (_token) return _token;
        if (!cfg.username || !cfg.password) return null;

        debug('auth: logging in as ' + cfg.username);
        var resp = apiPost('/login', JSON.stringify({
            username: cfg.username,
            password: cfg.password
        }));

        if (resp && resp.token) {
            _token = resp.token;
            debug('auth: OK');
        } else {
            log('auth: failed — ' + JSON.stringify(resp));
            _token = null;
        }
        return _token;
    }

    // ── Title cleaning ────────────────────────────────────────────────────────
    // "Movie.Name.2024.1080p.WEB-DL.DDP5.1.x264-GROUP" → "Movie Name 2024"
    function cleanFilename(raw) {
        if (!raw) return '';
        var name = String(raw)
            .replace(/^.*[\/\\]/, '')          // basename
            .replace(/\.[^.]+$/, '');          // drop extension

        name = name.replace(/[._]/g, ' ');

        // Cut at first technical token; keep year if it appears earlier
        name = name.replace(
            /\s+(1080p|720p|2160p|480p|576p|4K|UHD|BluRay|BDRip|BRRip|WEBRip|WEB[ -]?DL|HDTV|DVDRip|HDRip|x264|x265|H\.?265|HEVC|AVC|AAC|AC3|DDP\.?\d|DTS|TrueHD|Atmos|HDR10?|DV|AMZN|NF|DSNP|HMAX|ATVP|iTunes|REMUX|PROPER|REPACK|INTERNAL|EXTENDED|UNRATED|Directors?\.?Cut|S\d{1,2}E\d{1,2}).*/i,
            ''
        );

        return name.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    // ── Scoring ───────────────────────────────────────────────────────────────
    function scoreItem(attr) {
        var score = 50;

        if (attr.moviehash_match)        score += 30; // perfect hash match
        if (attr.from_trusted)           score += 10;
        if (attr.votes_rating > 8)     score += 8;
        else if (attr.votes_rating > 5) score += 4;

        if (attr.download_count > 10000)     score += 15;
        else if (attr.download_count > 5000) score += 10;
        else if (attr.download_count > 1000) score += 5;

        if (attr.machine_translated) score -= 20;
        if (attr.ai_translated)      score -= 15;

        // Hearing-impaired preference
        if (attr.hearing_impaired) {
            score += cfg.preferHI ? 8 : -8;
        }

        // Prefer newer uploads slightly
        if (attr.upload_date) {
            try {
                var ageDays = (Date.now() - Date.parse(attr.upload_date)) / 86400000;
                if (ageDays < 30)  score += 5;
                else if (ageDays < 365) score += 2;
            } catch (e) { /* ignore */ }
        }

        return Math.min(100, Math.max(0, Math.round(score)));
    }

    // ── Subtitle provider ─────────────────────────────────────────────────────
    subtitles.addProvider(function (req) {
        if (!cfg.apiKey) {
            log('search skipped: API Key not configured');
            return;
        }

        var query = (req.title && req.title !== '')
            ? req.title
            : cleanFilename(req.file || req.url || '');

        var lang = req.lang || 'en';

        log('search: "' + query + '" lang=' + lang +
            (req.imdb    ? ' imdb=' + req.imdb    : '') +
            (req.season  ? ' s' + req.season      : '') +
            (req.episode ? 'e' + req.episode      : '') +
            (req.year    ? ' year=' + req.year    : ''));

        if (!query && !req.imdb && !(req.hash || req.moviehash)) {
            log('search: nothing to search on, skipping');
            return;
        }

        // Build query args (OpenSubtitles API v1)
        var args = {
            languages: lang,
            order_by:  'download_count',
            order_direction: 'desc'
        };

        if (req.imdb) {
            args.imdb_id = String(req.imdb).replace(/^tt/i, '');
        }
        if (req.season)  args.season_number  = req.season;
        if (req.episode) args.episode_number = req.episode;
        if (req.year)    args.year           = req.year;
        if (query)       args.query          = query;

        // Hash search is the most accurate when available
        var moviehash = req.hash || req.moviehash || req.oshash;
        if (moviehash) {
            args.moviehash = moviehash;
            debug('using moviehash=' + moviehash);
        }
        if (req.filesize || req.size) {
            args.moviebytesize = req.filesize || req.size;
        }

        var data;
        try {
            data = apiGet('/subtitles', args);
        } catch (e) {
            log('search error: ' + e);
            return;
        }

        if (!data || !data.data || !data.data.length) {
            log('search: no results');
            return;
        }

        log('search: ' + data.data.length + ' result(s), registering up to ' + cfg.maxResults);

        var token = getToken();
        var added = 0;

        for (var i = 0; i < data.data.length && added < cfg.maxResults; i++) {
            var item = data.data[i];
            var attr = item.attributes;
            if (!attr) continue;

            var file = attr.files && attr.files[0];
            if (!file || !file.file_id) continue;

            var dlResp;
            try {
                dlResp = apiPost('/download',
                    JSON.stringify({ file_id: file.file_id }),
                    token
                );
            } catch (e) {
                log('download link error file_id=' + file.file_id + ': ' + e);
                continue;
            }

            if (!dlResp || !dlResp.link) {
                // Token may have expired / quota hit
                if (dlResp && (dlResp.message || '').toLowerCase().indexOf('token') !== -1) {
                    _token = null;
                }
                debug('download link missing: ' + JSON.stringify(dlResp));
                continue;
            }

            var featureTitle = (attr.feature_details && attr.feature_details.title) || query || 'Unknown';
            var title = '[' + (attr.language || lang) + '] ' + featureTitle;
            if (attr.release) title += '  · ' + attr.release;
            if (attr.hearing_impaired) title += ' [HI]';
            if (attr.machine_translated || attr.ai_translated) title += ' [MT]';

            var format = (attr.format || file.file_name || 'srt')
                .toString()
                .replace(/^.*\./, '')
                .toLowerCase() || 'srt';

            var score = scoreItem(attr);

            debug('adding: ' + title + ' score=' + score + ' remaining=' + (dlResp.remaining != null ? dlResp.remaining : '?'));

            req.addSubtitle(dlResp.link, title, attr.language || lang, format, 'OpenSubtitles', score);
            added++;
        }

        log('registered ' + added + ' subtitle(s)');
    });

    log(manifest.title + ' v' + manifest.version + ' loaded');

})(this);
