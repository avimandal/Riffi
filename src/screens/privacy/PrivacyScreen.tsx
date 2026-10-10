import { t } from '../../i18n';
import { back } from '../../app/router';
import { Icon } from '../../components/Icon';

export default function PrivacyScreen() {
  return (
    <div className="page privacy">
      <div className="topbar">
        <button className="btn icon-only round ghost" aria-label={t.common.back} onClick={() => back('/')}>
          <Icon name="arrow_back" />
        </button>
        <h1>{t.privacy.title}</h1>
      </div>
      <PrivacyContent />
    </div>
  );
}

export function PrivacyContent() {
  return (
    <div className="stack">
      <p>{t.privacy.intro}</p>
      {t.privacy.sections.map((s) => (
        <section key={s.heading} className="card flat">
          <h2>{s.heading}</h2>
          <p>{s.body}</p>
        </section>
      ))}
    </div>
  );
}
