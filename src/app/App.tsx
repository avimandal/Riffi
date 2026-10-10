import { lazy, Suspense, useEffect } from 'react';
import { t } from '../i18n';
import { AppStateProvider, useApp } from './state';
import { matchPath, navigate, usePath } from './router';
import { Layout } from './Layout';
import { ProfilesScreen } from '../screens/profiles/ProfilesScreen';
import { HomeScreen } from '../screens/home/HomeScreen';
import { UpdatePrompt } from './UpdatePrompt';

const AddMusicScreen = lazy(() => import('../screens/add/AddMusicScreen'));
const ReviewScreen = lazy(() => import('../screens/review/ReviewScreen'));
const PracticeScreen = lazy(() => import('../screens/practice/PracticeScreen'));
const ResultsScreen = lazy(() => import('../screens/results/ResultsScreen'));
const ProgressScreen = lazy(() => import('../screens/progress/ProgressScreen'));
const ParentScreen = lazy(() => import('../screens/parent/ParentScreen'));
const PrivacyScreen = lazy(() => import('../screens/privacy/PrivacyScreen'));
const GadgetScreen = lazy(() => import('../screens/gadget/GadgetScreen'));

/** Screens that need a kid selected. */
const NEEDS_PROFILE = ['/home', '/add', '/review', '/practice', '/results', '/progress', '/gadget'];

function Routes() {
  const path = usePath();
  const { profile, profiles } = useApp();
  const pathname = path.split('?')[0];
  const needsProfile = NEEDS_PROFILE.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  useEffect(() => {
    if (needsProfile && profiles && !profile) navigate('/', { replace: true });
  }, [needsProfile, profile, profiles]);

  if (needsProfile && !profile) return <div className="page" aria-busy="true" />;

  let m;
  let screen: JSX.Element;
  let nav = true;
  if (pathname === '/' || pathname === '') {
    screen = <ProfilesScreen />;
    nav = false;
  } else if (pathname === '/home') screen = <HomeScreen />;
  else if (pathname === '/add') screen = <AddMusicScreen />;
  else if ((m = matchPath('/review/:id', path))) screen = <ReviewScreen id={m.params.id} />;
  else if ((m = matchPath('/practice/:id', path))) {
    screen = <PracticeScreen id={m.params.id} query={m.query} />;
    nav = false;
  } else if ((m = matchPath('/results/:id', path))) screen = <ResultsScreen id={m.params.id} />;
  else if (pathname === '/progress') screen = <ProgressScreen />;
  else if (pathname === '/gadget') screen = <GadgetScreen />;
  else if (pathname === '/parent') {
    screen = <ParentScreen />;
    nav = !!profile;
  } else if (pathname === '/privacy') {
    screen = <PrivacyScreen />;
    nav = !!profile;
  } else {
    screen = (
      <div className="page">
        <h1>{t.errors.notFound}</h1>
        <button className="btn primary big" onClick={() => navigate('/')}>
          {t.errors.goHome}
        </button>
      </div>
    );
  }
  return (
    <Layout nav={nav} path={pathname}>
      <Suspense fallback={<div className="page" aria-busy="true" />}>{screen}</Suspense>
    </Layout>
  );
}

export function App() {
  return (
    <AppStateProvider>
      <Routes />
      <UpdatePrompt />
    </AppStateProvider>
  );
}
