import { SOCIAL_TITLE_REVIEWS } from '../../content/social-title-reviews.mjs';

const fold = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const roles = new Map(Object.entries({ engineer: 'Engineer', engenheiro: 'Engineer', engenheira: 'Engineer',
  developer: 'Developer', desenvolvedor: 'Developer', desenvolvedora: 'Developer', dev: 'Developer',
  programmer: 'Programmer', programador: 'Programmer', programadora: 'Programmer',
  designer: 'Designer', architect: 'Architect', arquiteto: 'Architect', arquiteta: 'Architect',
  analyst: 'Analyst', analista: 'Analyst', scientist: 'Scientist', cientista: 'Scientist',
  manager: 'Manager', gerente: 'Manager', researcher: 'Researcher' }));
const levels = new Map(Object.entries({ senior: 'Senior', sr: 'Senior', junior: 'Junior', jr: 'Junior',
  pleno: 'Mid-level', 'mid-level': 'Mid-level', staff: 'Staff', principal: 'Principal', lead: 'Lead',
  intern: 'Intern', estagiario: 'Intern', estagiaria: 'Intern' }));
const specialties = new Map(Object.entries({ backend: 'Backend', frontend: 'Frontend',
  fullstack: 'Full-stack', software: 'Software', platform: 'Platform', plataforma: 'Platform',
  data: 'Data', dados: 'Data', product: 'Product', produto: 'Product', mobile: 'Mobile',
  security: 'Security', seguranca: 'Security', cloud: 'Cloud', devops: 'DevOps',
  qa: 'QA', sre: 'Site Reliability', ux: 'UX', ui: 'UI', infrastructure: 'Infrastructure' }));
const technologies = ['TypeScript', 'JavaScript', 'Node.js', 'Next.js', 'React', 'Angular', 'Vue',
  'Python', 'Java', 'Kotlin', 'Swift', 'Go', 'Golang', 'Rust', 'Ruby', 'Rails', 'PHP', 'Laravel',
  'Django', 'C#', 'C++', '.NET', 'Flutter', 'Dart', 'SQL', 'PostgreSQL', 'AWS', 'Azure', 'Kubernetes'];

export function resolveSocialTitle(job, reviews = SOCIAL_TITLE_REVIEWS) {
  const review = reviews.find(entry => entry.jobId === job.id && entry.contentHash === job.contentHash
    && entry.sourceTitle === job.title);
  if (review && typeof review.title === 'string' && /^[\x20-\x7e·]{3,110}$/u.test(review.title)) {
    return Object.freeze({ status: 'ready', title: review.title.trim(), method: 'reviewed' });
  }
  const held = () => Object.freeze({ status: 'review_required', reason: 'social_title_review_required' });
  if (typeof job.title !== 'string' || job.title.length > 800) return held();
  let text = job.title.trim().normalize('NFKC');
  if (job.companyName) text = text.replace(new RegExp(`\\s+[-—|]\\s*${escape(job.companyName.trim())}$`, 'iu'), '');
  text = text.replace(/^\[(?:remote|remoto|hybrid|híbrido|on-site|presencial)\]\s*/iu, '')
    .replace(/^(?:we are hiring|we're hiring|hiring|estamos contratando)\s*[:!—-]\s*/iu, '')
    .replace(/募集$/u, '')
    .replace(/シニア/gu, ' Senior ').replace(/ジュニア/gu, ' Junior ')
    .replace(/バックエンド/gu, ' Backend ').replace(/フロントエンド/gu, ' Frontend ')
    .replace(/ソフトウェア/gu, ' Software ').replace(/エンジニア/gu, ' Engineer ');
  text = fold(text).replace(/\bback[ -]end\b/gu, 'backend')
    .replace(/\bfront[ -]end\b/gu, 'frontend').replace(/\bfull[ -]stack\b/gu, 'fullstack')
    .replace(/\bsite reliability\b/gu, 'sre').replace(/\bmid level\b/gu, 'mid-level');
  const stack = [];
  // Remove only explicit, complete technology names; never infer a stack from tags.
  const techPattern = new RegExp(`(^|[^a-z0-9])(${technologies.map(fold).sort((a,b) => b.length-a.length).map(escape).join('|')})(?=$|[^a-z0-9])`, 'gu');
  text = text.replace(techPattern, (match, prefix, name) => {
    const canonical = technologies.find(tech => fold(tech) === name);
    if (!stack.includes(canonical)) stack.push(canonical);
    return `${prefix} `;
  });
  const words = text.replace(/[()[\],/|·—:]/gu, ' ').replace(/\s+-\s+/gu, ' ').trim().split(/\s+/u).filter(Boolean);
  const role = [], level = [], specialty = [];
  for (const word of words) {
    if (roles.has(word)) role.push(roles.get(word));
    else if (levels.has(word)) level.push(levels.get(word));
    else if (specialties.has(word)) specialty.push(specialties.get(word));
    else if (word !== 'de') return held();
  }
  if (role.length !== 1 || level.length > 1 || specialty.length > 1 || stack.length > 3) return held();
  const title = [...level, ...specialty, ...role].join(' ') + (stack.length ? ` · ${stack.join(' / ')}` : '');
  if (title.length > 110) return held();
  return Object.freeze({ status: 'ready', title, method: 'vocabulary' });
}

export function prepareSocialJob(job) {
  const resolved = resolveSocialTitle(job);
  if (resolved.status !== 'ready') {
    const error = new Error('Social title requires human review');
    error.code = 'social_title_review_required';
    throw error;
  }
  return Object.freeze({ ...job, socialTitle: resolved.title });
}
