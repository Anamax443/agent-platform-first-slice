const toggle=document.querySelector('.mobile-toggle');
const nav=document.querySelector('.nav');
if(toggle&&nav){toggle.addEventListener('click',()=>nav.classList.toggle('open'));}
document.querySelectorAll('[data-demo-form]').forEach(form=>form.addEventListener('submit',e=>{e.preventDefault();const box=form.querySelector('[data-form-message]');if(box){box.textContent='Děkujeme. Toto je návrhová verze webu – formulář zatím nic neposílá.';box.style.display='block';}}));
