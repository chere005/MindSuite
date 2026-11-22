/**
 * The app's card (its name comes from brand.ts): sign in, sign up, and the
 * two-step email recovery. One screen, three modes — the login page never
 * draws chrome, matching the suite.
 *
 * With the suite's shared sign-in on, the WEB build has no form at all: it asks
 * the API who this browser is (api.ts, probeSharedSignIn) and either uses the
 * suite cookie or sends the person to /account/ and back. Native and the desktop
 * shell have no form either while the API says it takes app sign-in
 * (appsignin.ts, signin_info): one "Sign in" opens the suite's /account/app/ in
 * the system's authentication browser, where passwords, passkeys and password
 * managers work, and comes back signed in. The form below is for a server that
 * is not on shared sign-in (and for one too old to say). An account-optional
 * build can also offer the public account form when the API advertises it.
 *
 * In an account-optional build (accountmode.ts) this card is opened from
 * local mode, by Settings → "Sign in to sync and share", and it always offers
 * the way back. What was made on the device comes along: signing in or up
 * folds it into the account (store.tsx, signIn).
 */
import { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { defaultServerUrl } from '../config';
import { login, signup, recover, reset, cookieApi, cookieToken, claimAccountRedirect, probeSharedSignIn, type SharedProbe } from '../api';
import { useStore } from '../store';
import { Field, Pill, ErrorLine } from '../ui';
import { gateFor, signInFacts, signInPublicAccount, signInThroughAccount, type SignInFacts } from '../appsignin';
import { inDesktopShell, randomBytes, returnBrowser } from '../appsignin-browser';
import { passkeyAvailable, signInWithPasskey } from '../passkey';
import { themed, T } from '../theme';
import { Logo } from '../Logo';
import { APP_ID, APP_NAME } from '../brand';

type Mode = 'signin' | 'signup' | 'recover' | 'reset';

/**
 * What the card shows: the form, or (shared sign-in) a short wait or the reason it cannot continue. Native and the
 * desktop shell show 'app' (the one Sign in button), 'waiting' while the system browser has the person, and 'offline'.
 */
type Gate =
  | { at: 'checking' }
  | { at: 'form' }
  | { at: 'public'; household: boolean }
  | { at: 'app' }
  | { at: 'waiting' }
  | { at: 'offline' }
  | { at: 'redirecting' }
  | { at: 'stuck'; url: string }
  | { at: 'unavailable'; message: string };

export function Login() {
  const { signIn, localMode, closeSignIn } = useStore();
  const [mode, setMode] = useState<Mode>('signin');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Offered only where the device can actually make one. A button that
  // explains it cannot help you is worse than no button.
  const [canPasskey, setCanPasskey] = useState(false);
  useEffect(() => { void passkeyAvailable().then(setCanPasskey); }, []);
  const serverUrl = defaultServerUrl();
  // The system browser this build signs in with (native, the desktop shell), or null (the web build).
  const browser = useMemo(returnBrowser, []);
  const [gate, setGate] = useState<Gate>(() => (localMode || browser || cookieApi(serverUrl) ? { at: 'checking' } : { at: 'form' }));

  /**
   * Act on what the sign-in check found. True when it was handled here (the
   * cookie became the session, or the person is on their way to /account/ or
   * told why not); false for an API that is not on shared sign-in, or that did
   * not answer, which keeps the form.
   */
  const apply = async (p: SharedProbe): Promise<boolean> => {
    if (p.kind === 'cookie') {
      await signIn({ token: cookieToken(p.username), username: p.username, serverUrl });
      return true;
    }
    if (p.kind === 'account') {
      // Not twice in a row: the account page sent them back and the API still said no.
      if (claimAccountRedirect()) {
        setGate({ at: 'redirecting' });
        window.location.assign(p.url);
      } else {
        setGate({ at: 'stuck', url: p.url });
      }
      return true;
    }
    if (p.kind === 'unavailable') {
      setGate({ at: 'unavailable', message: p.message });
      return true;
    }
    setGate({ at: 'form' });
    return false;
  };
  // A failed probe cannot authorize a second, bearer-based web login or mark it as a known legacy session.
  const legacyFormAllowed = async (): Promise<boolean> => {
    if (!cookieApi(serverUrl)) return true;
    const p = await probeSharedSignIn(serverUrl);
    if (await apply(p)) return false;
    if (p.kind === 'legacy') return true;
    setError('Could not check your sign-in. Check your connection and try again.');
    return false;
  };
  const appGate = (facts: SignInFacts): Gate => {
    if (facts.kind === 'unavailable') return { at: 'unavailable', message: facts.message };
    const at = gateFor(facts, localMode);
    if (at === 'public') {
      const household = facts.kind === 'answer' && facts.shared && (browser ? facts.appSignIn : cookieApi(serverUrl));
      return { at, household };
    }
    return { at: at === 'unavailable' ? 'offline' : at };
  };
  const checkSignIn = async (isLive: () => boolean) => {
    if (localMode || browser) {
      const next = appGate(await signInFacts(serverUrl));
      if (!isLive()) return;
      if (browser || next.at === 'public') {
        setGate(next);
        return;
      }
    }
    const p = await probeSharedSignIn(serverUrl);
    if (isLive()) await apply(p);
  };
  const retry = () => {
    setGate({ at: 'checking' });
    void checkSignIn(() => true).catch(() => setGate({ at: browser ? 'offline' : 'form' }));
  };
  useEffect(() => {
    if (gate.at !== 'checking') return;
    let live = true;
    void checkSignIn(() => live).catch(() => { if (live) setGate({ at: browser ? 'offline' : 'form' }); });
    return () => { live = false; };
    // The initial check runs once per mount.
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'something went wrong');
    } finally {
      setBusy(false);
    }
  };

  /** Press Sign in: the system browser, then the code redeemed. A second press while waiting does nothing. */
  const startSignIn = async () => {
    if (!browser || (gate.at !== 'app' && gate.at !== 'public')) return;
    setError('');
    setGate({ at: 'waiting' });
    try {
      const r = await signInThroughAccount(serverUrl, APP_ID, browser, randomBytes);
      if (r.kind === 'ok') {
        await signIn(r.session);
        return;
      }
      setGate(gate);
      if (r.kind === 'error') setError(r.message);
    } catch (e) {
      setGate(gate);
      setError(e instanceof Error ? e.message : 'something went wrong');
    }
  };

  const publicForm = gate.at === 'public';
  const submit = () => {
    if (busy) return;
    if ((mode === 'signup' || mode === 'reset') && password !== confirmPw) {
      setError("those passwords don't match");
      return;
    }
    return run(async () => {
      if (publicForm) {
        if (mode !== 'signin' && mode !== 'signup') return;
        await signIn(await signInPublicAccount(serverUrl, username, password, mode === 'signup' ? email : undefined));
        return;
      }
      // The form is for servers that are not on shared sign-in. Ask again before it is used: a check that found
      // nothing (offline at load) must not let a password sign in with a token against a server that is.
      if (!(await legacyFormAllowed())) return;
      // Native and desktop: a server that now takes app sign-in switches the card and posts nothing.
      if (browser) {
        const next = appGate(await signInFacts(serverUrl));
        setGate(next);
        if (next.at === 'public') setMode('signin');
        if (next.at !== 'form') return;
      }
      if (mode === 'signin') {
        const r = await login(serverUrl, username, password);
        await signIn({ token: r.token, username: r.username, serverUrl, ...(cookieApi(serverUrl) ? { webLegacy: true as const } : {}) });
      } else if (mode === 'signup') {
        const r = await signup(serverUrl, username, email, password);
        await signIn({ token: r.token, username: r.username, serverUrl, ...(cookieApi(serverUrl) ? { webLegacy: true as const } : {}) });
      } else if (mode === 'recover') {
        await recover(serverUrl, username);
        setMode('reset');
      } else {
        const r = await reset(serverUrl, username, code, password);
        await signIn({ token: r.token, username: r.username, serverUrl, ...(cookieApi(serverUrl) ? { webLegacy: true as const } : {}) });
      }
    });
  };

  if (gate.at !== 'form' && gate.at !== 'public') {
    return (
      <View style={s.page}>
        <View style={s.card}>
          <View style={s.mark}><Logo size={64} /></View>
          <Text style={s.logo}>{APP_NAME}</Text>
          {gate.at === 'checking' && <Text style={s.hint}>Checking your sign-in…</Text>}
          {gate.at === 'redirecting' && <Text style={s.hint}>Taking you to the sign-in page…</Text>}
          {gate.at === 'app' && (
            <>
              <Text style={s.hint}>Sign in with your MindSuite account. It opens in your browser, where your saved passwords and passkeys work.</Text>
              <ErrorLine text={error} />
              <View style={s.actions}>
                <Pill primary testID="app-signin" label="Sign in" onPress={() => void startSignIn()} />
              </View>
            </>
          )}
          {gate.at === 'waiting' && (
            inDesktopShell() ? (
              <>
                <Text style={s.hint}>Finish signing in in your browser, then come back here.</Text>
                <View style={s.actions}>
                  <Pill testID="app-signin-cancel" label="Cancel" onPress={() => void browser?.cancel()} />
                </View>
              </>
            ) : (
              <Text style={s.hint}>Signing in…</Text>
            )
          )}
          {gate.at === 'offline' && (
            <>
              <ErrorLine text="Could not reach the server. Check your connection and try again." />
              <View style={s.actions}>
                <Pill primary testID="app-signin-retry" label="Try again" onPress={retry} />
              </View>
            </>
          )}
          {gate.at === 'stuck' && (
            <>
              <Text style={s.hint}>Sign in on the account page to use {APP_NAME}.</Text>
              <View style={s.actions}>
                <Pill primary testID="shared-signin" label="Sign in" onPress={() => window.location.assign(gate.url)} />
              </View>
            </>
          )}
          {gate.at === 'unavailable' && (
            <>
              <ErrorLine text={gate.message} />
              <View style={s.actions}>
                <Pill
                  primary
                  testID="shared-retry"
                  label="Try again"
                  onPress={retry}
                />
              </View>
            </>
          )}
          {localMode && <LocalWayBack onPress={closeSignIn} />}
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={s.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={s.card}>
        <View style={s.mark}><Logo size={64} /></View>
        <Text style={s.logo}>{APP_NAME}</Text>
        <Field value={username} onChangeText={setUsername} placeholder="Username" autoCapitalize="none" autoCorrect={false} />
        {mode === 'signup' && (
          <Field value={email} onChangeText={setEmail} placeholder="Email" autoCapitalize="none" keyboardType="email-address" />
        )}
        {mode === 'reset' && (
          <>
            <Text style={s.hint}>If that account exists, a 6-digit code went to its email.</Text>
            <Field value={code} onChangeText={setCode} placeholder="Code" keyboardType="number-pad" maxLength={6} />
          </>
        )}
        {mode !== 'recover' && (
          <Field
            value={password}
            onChangeText={setPassword}
            placeholder={mode === 'reset' ? 'New password' : 'Password'}
            secureTextEntry
            onSubmitEditing={submit}
          />
        )}
        {(mode === 'signup' || mode === 'reset') && (
          <Field
            testID="login-confirm"
            value={confirmPw}
            onChangeText={setConfirmPw}
            placeholder="Confirm password"
            secureTextEntry
            onSubmitEditing={submit}
          />
        )}
        <ErrorLine text={error} />
        <View style={s.actions}>
          <Pill
            primary
            disabled={busy}
            label={mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Sign up' : mode === 'recover' ? 'Send code' : 'Set password'}
            onPress={submit}
          />
        </View>
        {mode === 'signin' && !publicForm && canPasskey && !inDesktopShell() && (
          <View style={s.actions}>
            <Pill
              testID="passkey-signin"
              disabled={busy}
              label="Use a passkey"
              onPress={() => run(async () => {
                if (!(await legacyFormAllowed())) return;
                const r = await signInWithPasskey(serverUrl);
                await signIn({ ...r, ...(cookieApi(serverUrl) ? { webLegacy: true as const } : {}) });
              })}
            />
          </View>
        )}
        <View style={s.links}>
          {mode !== 'signin' && <Pill disabled={busy} label="Sign in" onPress={() => setMode('signin')} />}
          {mode === 'signin' && <Pill disabled={busy} label="Sign up" onPress={() => setMode('signup')} />}
          {mode === 'signin' && !publicForm && <Pill label="Forgot?" onPress={() => setMode('recover')} />}
          {gate.at === 'public' && gate.household && mode === 'signin' && (
            <Pill disabled={busy} label="Use a MindSuite account" onPress={() => {
              if (browser) { void startSignIn(); return; }
              void run(async () => {
                const p = await probeSharedSignIn(serverUrl);
                if (p.kind === 'legacy' || p.kind === 'unknown') {
                  setError('Could not check your MindSuite sign-in. Try again.');
                  return;
                }
                await apply(p);
              });
            }} />
          )}
        </View>
        {localMode && <LocalWayBack onPress={closeSignIn} disabled={busy} />}
      </View>
    </KeyboardAvoidingView>
  );
}

/** Local mode only: what signing in does with this device's records, and the way back to them. */
function LocalWayBack({ onPress, disabled }: { onPress: () => void; disabled?: boolean }) {
  return (
    <View style={s.local}>
      <Text style={s.hint}>What you made on this device comes with you when you sign in or sign up.</Text>
      <Pill testID="use-locally" label="Continue without an account" onPress={onPress} disabled={disabled} />
    </View>
  );
}

const s = themed(() => StyleSheet.create({
  page: { flex: 1, backgroundColor: T.bg, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: T.surface,
    borderWidth: 1,
    borderColor: T.line,
    borderRadius: 16,
    padding: 20,
    gap: 10,
  },
  mark: { alignItems: 'center', marginBottom: 2 },
  logo: { color: T.accent, fontSize: 24, fontWeight: '700', textAlign: 'center', marginBottom: 6 },
  hint: { color: T.dim, fontSize: 13 },
  actions: { marginTop: 4, alignItems: 'stretch' },
  links: { flexDirection: 'row', gap: 8, justifyContent: 'center', marginTop: 4 },
  local: { gap: 8, marginTop: 6, borderTopWidth: 1, borderTopColor: T.line, paddingTop: 10, alignItems: 'stretch' },
}));
