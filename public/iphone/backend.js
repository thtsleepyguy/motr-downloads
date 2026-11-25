/* Browser client for the same Supabase project used by MOTR Android. */
(function () {
  'use strict';
  var origin = 'https://aysittzygsepshxadckb.supabase.co';
  var key = 'sb_publishable_evYXZXj6QGWRrMLPUv04bw_JbZa0FEo';
  var sessionKey = 'motr-iphone-session-v1';
  var refreshing;
  var generation = 0;

  function read(name, otherwise) {
    try {
      var value = localStorage.getItem(name);
      return value === null ? otherwise : JSON.parse(value);
    } catch (_) { return otherwise; }
  }

  function write(name, value) {
    try {
      if (value === null) localStorage.removeItem(name);
      else localStorage.setItem(name, JSON.stringify(value));
    } catch (_) { /* Session and preferences can still work until this page closes. */ }
  }

  var session = read(sessionKey, null);

  function save(next) {
    session = next;
    write(sessionKey, next);
    return next;
  }

  function request(route, options) {
    var headers = { apikey: key, Accept: 'application/json' };
    if (options.token) headers.Authorization = 'Bearer ' + options.token;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.prefer) headers.Prefer = options.prefer;
    return fetch(origin + route, {
      method: options.method || 'GET', headers: headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store', credentials: 'omit', redirect: 'error',
      keepalive: Boolean(options.keepalive)
    }).then(function (response) {
      return response.text().then(function (body) {
        var data = body ? JSON.parse(body) : null;
        if (!response.ok) {
          var error = new Error(data && (data.msg || data.message || data.error_description) || 'MOTR is temporarily unavailable.');
          error.status = response.status;
          error.code = data && data.code;
          throw error;
        }
        return data;
      });
    });
  }

  function auth(route, body, token, method) {
    return request('/auth/v1/' + route, { method: method || 'POST', body: body, token: token });
  }

  function useSession(data) {
    if (!data || typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string' || !data.user || !data.user.id) {
      throw new Error('Your account needs verification before you can sign in.');
    }
    data.expires_at = Number(data.expires_at) || Math.floor(Date.now() / 1000) + (Number(data.expires_in) || 0);
    generation++;
    return save(data);
  }

  function ensure() {
    if (!session) return Promise.reject(new Error('Sign in to continue.'));
    if (session.expires_at > Date.now() / 1000 + 45) return Promise.resolve(session);
    if (refreshing) return refreshing;
    var current = session;
    var version = generation;
    refreshing = auth('token?grant_type=refresh_token', { refresh_token: current.refresh_token }).then(function (data) {
      if (version !== generation) throw new Error('Your session changed. Please try again.');
      return useSession(data);
    }).catch(function (error) {
      if (version === generation && (error.status === 400 || error.status === 401)) {
        var latest = read(sessionKey, null);
        if (latest && latest.refresh_token !== current.refresh_token) return save(latest);
        save(null);
        window.dispatchEvent(new Event('motr-session-expired'));
        throw new Error('Your session expired. Sign in again.');
      }
      throw error;
    });
    refreshing.then(function () { refreshing = null; }, function () { refreshing = null; });
    return refreshing;
  }

  function rest(route, options) {
    options = options || {};
    return ensure().then(function (active) {
      if (options.isCurrent && !options.isCurrent()) throw new Error('Sharing paused.');
      options.token = active.access_token;
      return request('/rest/v1/' + route, options);
    });
  }

  function rpc(name, args, keepalive, isCurrent) {
    return rest('rpc/' + name, { method: 'POST', body: args || {}, keepalive: keepalive, isCurrent: isCurrent });
  }

  window.motrApi = {
    read: read, write: write, current: function () { return session; }, ensure: ensure,
    signIn: function (email, password) { return auth('token?grant_type=password', { email: email, password: password }).then(useSession); },
    signUp: function (email, password) {
      return auth('signup', { email: email, password: password }).then(function (data) {
        return data && data.access_token ? useSession(data) : null;
      });
    },
    recover: function (email) { return auth('recover', { email: email }); },
    verify: function (email, token, type) {
      return auth('verify', { email: email, token: token, type: type }).then(function (data) {
        return type === 'recovery' ? data : useSession(data);
      });
    },
    reset: function (password, recovery) { return auth('user', { password: password }, recovery.access_token, 'PUT').then(function () { return useSession(recovery); }); },
    signOut: function () {
      var previous = session;
      generation++;
      save(null);
      if (!previous) return Promise.resolve();
      return auth('logout?scope=local', undefined, previous.access_token).catch(function () {});
    },
    rpc: rpc, rest: rest
  };
}());
