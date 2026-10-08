const observer = new IntersectionObserver(entries => entries.forEach(entry => {
  if (entry.isIntersecting) entry.target.classList.add('visible');
}), { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

const steps = [...document.querySelectorAll('.arch-step')];
let active = 0;
setInterval(() => {
  steps[active].classList.remove('active');
  active = (active + 1) % steps.length;
  steps[active].classList.add('active');
}, 2400);
