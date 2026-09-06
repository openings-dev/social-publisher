import fixture from '../../../assets/fixtures/job.json' with { type: 'json' };

// Review fixtures, not live listings. Keep extremes here to exercise the artwork.
export const PREVIEW_SAMPLES = Object.freeze([
  { key: 'typescript', label: 'Cargo + empresa + salário', job: { ...fixture, companyName: 'Example Studio' } },
  { key: 'hourly', label: 'Salário por hora · caso do corte', job: {
    ...fixture, id: 'gh_1123456789abcdef01234567', title: '[Remoto] Back-end C#/Net - Micro1',
    companyName: 'Micro1', community: { ...fixture.community, name: 'backend-br' },
    country: 'Brazil', region: 'South America', tags: ['remote', 'C#', '.NET'],
    salary: { currency: 'USD', min: 60, max: 110, period: 'hour' },
  } },
  { key: 'frontend', label: 'Frontend · salário anual', job: {
    ...fixture, id: 'gh_5123456789abcdef01234567', title: 'Frontend Engineer',
    companyName: 'Example Labs', country: 'Portugal', region: 'Europe', tags: ['remote', 'React'],
    salary: { currency: 'EUR', min: 65000, max: 85000, period: 'year' },
  } },
  { key: 'long', label: 'Título e empresa longos', job: {
    ...fixture, id: 'gh_2123456789abcdef01234567',
    title: 'Principal Platform Engineer building reliable distributed systems and developer infrastructure',
    companyName: 'Example International Developer Infrastructure Company',
    tags: ['hybrid', 'Kubernetes', 'TypeScript', 'developer experience'],
    country: 'United Kingdom', region: 'Europe', salary: null,
  } },
  { key: 'minimal', label: 'Poucos dados · sem salário', job: {
    ...fixture, id: 'gh_3123456789abcdef01234567', title: 'Product Designer',
    companyName: null, salary: null, country: null, region: null, tags: [],
    community: { ...fixture.community, name: 'design-community' },
  } },
  { key: 'multilingual', label: 'Multilíngue + salário extenso', job: {
    ...fixture, id: 'gh_4123456789abcdef01234567',
    title: '東京勤務 シニアソフトウェアエンジニア プラットフォーム信頼性と開発者体験',
    companyName: 'Example Tokyo', country: 'Japan', region: 'Asia', tags: ['on-site', 'Rust'],
    salary: { currency: 'JPY', min: 9000000, max: 14000000, period: 'year' },
  } },
]);
