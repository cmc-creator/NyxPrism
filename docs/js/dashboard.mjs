// NyxPrism dashboard main module (moved out of dashboard.html).
import { initializeApp }   from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut, EmailAuthProvider, reauthenticateWithCredential, updatePassword, verifyBeforeUpdateEmail, sendEmailVerification, reload } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore, doc, getDoc }            from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey:"AIzaSyD7bj__SwM4gE_yDnM9jjmzOgh6mX4NiD0",
  authDomain:"nyxprism-2a817.firebaseapp.com",
  projectId:"nyxprism-2a817",
  storageBucket:"nyxprism-2a817.firebasestorage.app",
  messagingSenderId:"388040998105",
  appId:"1:388040998105:web:8e3fbfd27db0fdd60dd2c8",
  measurementId:"G-7XMV6H0KNM"
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// ── Update to your Railway backend URL ────────────────────────────
const API = window.NYX_API || 'https://nyxprism-production.up.railway.app';
document.getElementById('verify-resend-btn')?.addEventListener('click',async function(){
  this.disabled=true;
  try{await sendEmailVerification(auth.currentUser);toast('Verification email sent. Check your inbox (and spam).','success');}
  catch(err){toast(err?.code==='auth/too-many-requests'?'Please wait a few minutes before requesting another email.':'Could not send the email. Try again shortly.','error');}
  finally{setTimeout(()=>{this.disabled=false;},30000);}
});
document.getElementById('verify-done-btn')?.addEventListener('click',async()=>{
  await reload(auth.currentUser);
  if(auth.currentUser.emailVerified){await auth.currentUser.getIdToken(true);document.getElementById('verify-banner').style.display='none';toast('Email verified. You can now send documents.','success');}
  else toast("It isn't verified yet. Click the link in the email first.",'error');
});
// Professional-only endpoints answer 403 for free accounts; offer the upgrade instead of a dead end.
const PRO_ENDPOINT=/\/api\/(sign-requests|distributions|ai-split|ai-assist|keys)(\/|$|\?)/;
const _nyxFetch=window.fetch.bind(window);
window.fetch=async function(input,init){
  const res=await _nyxFetch(input,init);
  try{
    const url=typeof input==='string'?input:input.url;
    if(res.status===403&&url.startsWith(API)&&PRO_ENDPOINT.test(url)){
      const body=await res.clone().json().catch(()=>({}));
      if(/Professional subscription is required/i.test(body.error||'')){const m=document.getElementById('upgrade-modal');if(m)m.style.display='flex';}
      if(body.code==='email_unverified'){const vb=document.getElementById('verify-banner');if(vb){vb.style.display='flex';vb.scrollIntoView({behavior:'smooth',block:'start'});}}
    }
  }catch(_){}
  return res;
};
window.__nyxLaunchFiles=[];
window.__nyxDashboardReady=false;
window.__nyxProcessLaunchFiles=async function(){
  if(!window.__nyxDashboardReady||!window.__nyxOpenPdf||!window.__nyxLaunchFiles.length)return;
  const file=window.__nyxLaunchFiles.shift();
  await window.__nyxOpenPdf(file);
  if(window.__nyxLaunchFiles.length)toast(`${window.__nyxLaunchFiles.length} additional PDF${window.__nyxLaunchFiles.length===1?' is':'s are'} waiting. Open them one at a time.`,'info');
};

let deferredInstallPrompt=null;
const installAppBtn=document.getElementById('install-app-btn');
window.addEventListener('beforeinstallprompt',event=>{
  event.preventDefault();deferredInstallPrompt=event;installAppBtn?.classList.add('available');
});
installAppBtn?.addEventListener('click',async()=>{
  if(!deferredInstallPrompt)return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt=null;installAppBtn.classList.remove('available');
});
window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;installAppBtn?.classList.remove('available');toast('NyxPrism installed. You can now open PDF files with it.','success');});

const Stats = {
  get:()=>JSON.parse(localStorage.getItem('nyx_stats')||'{"processed":0,"saved":0}'),
  inc(savedMB=0){const s=this.get();s.processed++;s.saved=Math.round((s.saved+savedMB)*10)/10;localStorage.setItem('nyx_stats',JSON.stringify(s));renderStats(s);}
};
function countUp(el,target,dur){
  if(!el)return;
  var start=parseFloat(el.textContent)||0;
  var isFloat=String(target).indexOf('.')!==-1;
  if(start===target){el.textContent=isFloat?target.toFixed(1):target;return;}
  var t0=null;
  function step(ts){if(!t0)t0=ts;var p=Math.min((ts-t0)/dur,1);var e2=1-Math.pow(1-p,3);var cur=start+(target-start)*e2;
    el.textContent=isFloat?cur.toFixed(1):Math.round(cur);if(p<1)requestAnimationFrame(step);}
  requestAnimationFrame(step);
}
function renderStats(s){
  var a=document.getElementById('stat-processed'),b=document.getElementById('stat-saved');
  countUp(a,s.processed,900); countUp(b,s.saved,900);
}

const loading=document.getElementById('loading-screen'),content=document.getElementById('main-content');

// Safety-net: force-hide spinner after 12s if JS hangs
const _loadTimeout=setTimeout(()=>{
  if(loading&&loading.style.display!=='none'){
    loading.style.opacity='0';
    setTimeout(()=>{loading.style.display='none';if(content)content.style.display='block';},300);
  }
},12000);

// Handle Stripe redirect back to dashboard
const _urlP=new URLSearchParams(window.location.search);
if(_urlP.get('checkout')==='success'){window.__checkoutSuccess=true;history.replaceState({},'',window.location.pathname);}

onAuthStateChanged(auth,async user=>{
  if(!user){clearTimeout(_loadTimeout);window.location.replace('login.html');return;}
  let firstName='',lastName='',plan=null,trialStart=null,subscriptionStatus=null,currentPeriodEnd=null,createdAt=null;
  const ownerAccount=(user.email||'').toLowerCase()==='cmc@conniemichelleconsulting.com';
  // Primary: backend API (reflects latest Stripe state)
  try{
    const token=await user.getIdToken();
    const r=await fetch(`${API}/api/user/me`,{headers:{Authorization:`Bearer ${token}`}});
    if(r.ok){const d=await r.json();firstName=d.first_name||'';lastName=d.last_name||'';plan=d.plan||null;window.__nyxTeam=d.team||null;trialStart=d.trial_start?new Date(d.trial_start):null;subscriptionStatus=d.subscription_status||null;currentPeriodEnd=d.current_period_end?new Date(d.current_period_end):null;createdAt=d.created_at?new Date(d.created_at):null;}
  }catch(_){}
  if(ownerAccount){plan='professional';subscriptionStatus='active';trialStart=null;currentPeriodEnd=null;}
  const verifyBanner=document.getElementById('verify-banner');
  // Owner and store-reviewer accounts are exempt from email verification on the server, so don't nag them.
  const reviewerAccount=(user.email||'').toLowerCase()==='msstore-review@nyxprism.com';
  if(verifyBanner){verifyBanner.style.display=(user.emailVerified||ownerAccount||reviewerAccount)?'none':'flex';document.getElementById('verify-email').textContent=user.email;}
  const ownerLink=document.getElementById('sidebar-owner-portal');if(ownerLink)ownerLink.style.display=ownerAccount?'flex':'none';
  if(!plan){plan='account';setTimeout(()=>toast('Account status could not be refreshed. Your tools remain available while we retry.','error'),400);}
  // Fallback: Firestore for name only
  if(!firstName){try{const snap=await getDoc(doc(db,'users',user.uid));if(snap.exists())firstName=snap.data().firstName||'';}catch(_){}}
  // Trial expiry
  let trialExpired=false,daysLeft=0;
  if(plan==='trial'&&trialStart){const e=new Date(trialStart);e.setDate(e.getDate()+14);daysLeft=Math.max(0,Math.ceil((e-new Date())/86400000));trialExpired=daysLeft===0;}
  // An ended trial drops to the free tools (with an upgrade prompt); only an admin-set 'inactive' plan blocks the app.
  window.__nyxBlocked=(plan==='inactive');
  window.__nyxPlan=plan;
  const planLabel=plan.charAt(0).toUpperCase()+plan.slice(1);
  document.getElementById('nav-initial').textContent=(firstName||user.email)[0].toUpperCase();
  document.getElementById('nav-dropdown-email').textContent=user.email;
  document.getElementById('nav-plan-badge').textContent=planLabel;
  document.getElementById('stat-plan').textContent=planLabel;
  document.getElementById('home-welcome').textContent=`Welcome back${firstName?', '+firstName:''}!`;
  // Trial banner
  document.getElementById('trial-banner').style.display='none';
  if(plan==='trial'&&trialStart){
    document.getElementById('trial-banner').style.display='flex';
    if(daysLeft>0){document.getElementById('trial-days').textContent=`${daysLeft} day${daysLeft!==1?'s':''}`;document.getElementById('trial-msg').textContent='left in your free trial - upgrade to keep full access.';}
    else{document.getElementById('trial-days').textContent='Your trial has ended.';document.getElementById('trial-msg').textContent='The free tools are still yours. Upgrade to keep Professional features.';}
  }
  // Account panel
  const accE=document.getElementById('acc-email');if(accE)accE.textContent=user.email;const accU=document.getElementById('acc-pw-username');if(accU)accU.value=user.email;
  const accN=document.getElementById('acc-name');if(accN)accN.textContent=(firstName+(lastName?' '+lastName:''))||'-';
  const accFN=document.getElementById('acc-first-name');if(accFN)accFN.value=firstName;
  const accLN=document.getElementById('acc-last-name');if(accLN)accLN.value=lastName;
  const accS=document.getElementById('acc-since');if(accS&&createdAt)accS.textContent=createdAt.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
  const accP=document.getElementById('acc-plan');if(accP)accP.textContent=planLabel+(window.__nyxTeam?` · via ${window.__nyxTeam.name}`:'');
  const accSt=document.getElementById('acc-status');
  if(accSt){if(subscriptionStatus&&['active','trialing'].includes(subscriptionStatus))accSt.innerHTML=`<span class="account-badge-active">${subscriptionStatus}</span>`;else if(plan==='trial')accSt.innerHTML='<span class="account-badge-trial">Free Trial</span>';else if(subscriptionStatus)accSt.innerHTML=`<span class="account-badge-inactive">${subscriptionStatus}</span>`;else accSt.textContent='-';}
  const accPR=document.getElementById('acc-period-row'),accPD=document.getElementById('acc-period');
  if(accPR&&accPD&&currentPeriodEnd){accPR.style.display='flex';accPD.textContent=currentPeriodEnd.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});}
  window.__nyxHasPro=plan==='professional'||(plan==='trial'&&!trialExpired);
  const accUpBtn=document.getElementById('acc-upgrade-btn');if(accUpBtn&&!window.__nyxHasPro&&plan!=='account')accUpBtn.style.display='inline-flex';
  renderStats(Stats.get());
  clearTimeout(_loadTimeout);
  loading.style.opacity='0';
  setTimeout(()=>loading.style.display='none',300);
  content.style.display='block';
  window.__nyxDashboardReady=true;
  // Deep links such as dashboard.html#split open that tool directly (used by the public tool pages).
  const linkedPanel=decodeURIComponent(location.hash.slice(1));
  if(/^[a-z]+$/.test(linkedPanel)&&document.getElementById('panel-'+linkedPanel))switchPanel(linkedPanel);
  window.__nyxProcessLaunchFiles();
  if(window.__checkoutSuccess){window.__checkoutSuccess=false;setTimeout(()=>toast('Subscription activated - welcome to NyxPrism Professional! 🎉','success'),400);}
});

const _doSignOut=async()=>{await signOut(auth);window.location.replace('login.html');};
document.getElementById('signout-btn').addEventListener('click',_doSignOut);
document.getElementById('sidebar-signout-btn').addEventListener('click',_doSignOut);

async function startCheckout(plan,btn){
  const orig=btn.innerHTML;btn.disabled=true;btn.textContent='Redirecting…';
  try{
    const token=await auth.currentUser?.getIdToken(true);
    if(!token)throw new Error('Please sign in again.');
    const res=await fetch(`${API}/api/stripe/create-checkout`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({plan})});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||'Checkout failed.');
    window.location.href=data.url;
  }catch(err){toast(err.message,'error');btn.disabled=false;btn.innerHTML=orig;}
}

async function openBillingPortal(btn){
  const orig=btn.innerHTML;btn.disabled=true;btn.textContent='Opening…';
  try{
    const token=await auth.currentUser?.getIdToken(true);
    if(!token)throw new Error('Please sign in again.');
    const res=await fetch(`${API}/api/stripe/create-portal`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`}});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||'Could not open billing portal.');
    window.location.href=data.url;
  }catch(err){toast(err.message,'error');btn.disabled=false;btn.innerHTML=orig;}
}

document.getElementById('upgrade-modal-monthly').addEventListener('click',function(){startCheckout('monthly',this);});
document.getElementById('upgrade-modal-annual').addEventListener('click',function(){startCheckout('annual',this);});
document.getElementById('upgrade-modal-close').addEventListener('click',()=>document.getElementById('upgrade-modal').style.display='none');
document.getElementById('upgrade-modal').addEventListener('click',e=>{if(e.target===document.getElementById('upgrade-modal'))document.getElementById('upgrade-modal').style.display='none';});
document.getElementById('upgrade-now-btn').addEventListener('click',function(){startCheckout('monthly',this);});
document.getElementById('acc-manage-billing').addEventListener('click',function(){openBillingPortal(this);});
document.getElementById('acc-upgrade-btn').addEventListener('click',()=>document.getElementById('upgrade-modal').style.display='flex');
document.getElementById('nav-manage-billing-btn').addEventListener('click',function(){openBillingPortal(this);});

window.__nyxGetToken=()=>auth.currentUser?.getIdToken();

// ── THEME TOGGLE ──
(function(){
  var THEME_KEY = "nyx_theme";
  function applyTheme(mode){
    if(mode === "light") document.body.classList.add("light");
    else document.body.classList.remove("light");
  }
  var saved = localStorage.getItem(THEME_KEY);
  if(saved) applyTheme(saved);
  var toggleBtn = document.getElementById("theme-toggle");
  if(toggleBtn) toggleBtn.addEventListener("click", function(){
    var isLight = document.body.classList.toggle("light");
    localStorage.setItem(THEME_KEY, isLight ? "light" : "dark");
  });
})();

// ── ACCOUNT SETTINGS: profile, security, appearance ──
(function(){
  const profileResult=document.getElementById('acc-profile-result'),securityResult=document.getElementById('acc-security-result');
  if(!profileResult||!securityResult)return;
  function friendlyAuthError(err){
    const code=err?.code||'';
    if(code.includes('wrong-password')||code.includes('invalid-credential'))return 'Current password is incorrect.';
    if(code.includes('weak-password'))return 'That password is too weak.';
    if(code.includes('email-already-in-use'))return 'That email address is already in use.';
    if(code.includes('requires-recent-login'))return 'Please sign out, sign back in, and try again.';
    if(code.includes('too-many-requests'))return 'Too many attempts. Wait a few minutes and try again.';
    return err?.message||'Something went wrong.';
  }
  async function reauth(){
    const current=document.getElementById('acc-current-password').value;
    if(!current)throw new Error('Enter your current password first.');
    await reauthenticateWithCredential(auth.currentUser,EmailAuthProvider.credential(auth.currentUser.email,current));
  }
  document.getElementById('acc-save-name').addEventListener('click',async function(){
    const firstName=document.getElementById('acc-first-name').value.trim();
    const lastName=document.getElementById('acc-last-name').value.trim();
    if(!firstName)return showResult(profileResult,'error','First name is required.');
    this.disabled=true;
    try{
      const token=await auth.currentUser?.getIdToken(true);if(!token)throw new Error('Please sign in again.');
      const res=await fetch(`${API}/api/user/profile`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({firstName,lastName})});
      const data=await res.json();if(!res.ok)throw new Error(data.error||'Could not save your name.');
      document.getElementById('acc-name').textContent=firstName+(lastName?' '+lastName:'');
      document.getElementById('home-welcome').textContent=`Welcome back, ${firstName}!`;
      document.getElementById('nav-initial').textContent=firstName[0].toUpperCase();
      showResult(profileResult,'success','Name updated.');
    }catch(err){showResult(profileResult,'error',err.message);}finally{this.disabled=false;}
  });
  document.getElementById('acc-password-form').addEventListener('submit',async function(e){
    e.preventDefault();
    const newPass=document.getElementById('acc-new-password').value,confirmPass=document.getElementById('acc-confirm-password').value;
    if(newPass.length<8)return showResult(securityResult,'error','New password must be at least 8 characters.');
    if(newPass!==confirmPass)return showResult(securityResult,'error','New passwords do not match.');
    const btn=document.getElementById('acc-change-password');btn.disabled=true;
    try{
      await reauth();await updatePassword(auth.currentUser,newPass);
      // Prove the new password works before telling the user it changed.
      try{await reauthenticateWithCredential(auth.currentUser,EmailAuthProvider.credential(auth.currentUser.email,newPass));}
      catch(_){throw new Error('Firebase did not accept the new password. Your password was not changed - please try again.');}
      // Tell the browser's password manager about the new password so it stops autofilling the old one at login.
      if(window.PasswordCredential&&navigator.credentials?.store){
        try{await navigator.credentials.store(new PasswordCredential({id:auth.currentUser.email,password:newPass}));}catch(_){}
      }
      ['acc-current-password','acc-new-password','acc-confirm-password'].forEach(id=>document.getElementById(id).value='');
      showResult(securityResult,'success','Password changed and verified for '+auth.currentUser.email+'. Use the new password next time you sign in.');
    }catch(err){showResult(securityResult,'error',friendlyAuthError(err));}finally{btn.disabled=false;}
  });
  // Team (Enterprise)
  const teamBody=document.getElementById('team-body'),teamResult=document.getElementById('team-result');
  async function teamCall(path,opts={}){const token=await auth.currentUser.getIdToken();const res=await fetch(`${API}/api/teams${path}`,{...opts,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`}});const d=await res.json().catch(()=>({}));if(!res.ok)throw new Error(d.error||'Something went wrong.');return d;}
  function el(tag,props={},...kids){const e=document.createElement(tag);Object.assign(e,props);kids.forEach(k=>e.append(k));return e;}
  async function loadTeam(){
    let d;try{d=await teamCall('/mine');}catch(err){teamBody.textContent=err.message;return;}
    teamBody.replaceChildren();
    if(!d.team){
      teamBody.append(el('p',{style:'margin:0 0 .5rem;line-height:1.55',textContent:'Teams let you give colleagues Professional access under one account and bill, with shared signature templates.'}),
        el('p',{style:'margin:0;color:var(--text3)'},'Teams are part of NyxPrism Enterprise. ',el('a',{href:'contact.html',textContent:'Contact us to set one up'}),'.'));
      return;
    }
    if(!d.members){
      teamBody.append(el('p',{style:'margin:0 0 .75rem;line-height:1.55'},'You\u2019re a ',el('strong',{textContent:d.role==='admin'?'team admin':'member'}),' of ',el('strong',{textContent:d.team.name}),d.active===false?' - the team owner\u2019s plan is inactive, so Professional access is paused.':' - Professional access comes with the team.'));
      const leave=el('button',{className:'btn btn-secondary',type:'button',textContent:'Leave team'});
      leave.onclick=async()=>{if(!confirm(`Leave ${d.team.name}? You'll lose the Professional access that comes with it.`))return;try{await teamCall('/leave',{method:'POST'});toast('You left the team','success');loadTeam();location.reload();}catch(err){showResult(teamResult,'error',err.message);}};
      teamBody.append(el('div',{className:'btn-row'},leave));return;
    }
    teamBody.append(el('p',{style:'margin:0 0 .75rem'},el('strong',{textContent:d.team.name}),` · ${d.team.used} of ${d.team.seats} seats used`,d.role==='owner'?' · you own this team':' · you\u2019re an admin'));
    const list=el('div',{className:'review-signers',style:'margin-bottom:.9rem'});
    list.append(el('div',{className:'review-signer'},el('span',{className:'order',textContent:'★'}),el('div',{className:'who',textContent:(d.owner.first_name||d.owner.email)+' · owner'},el('small',{textContent:d.owner.email}))));
    d.members.forEach(m=>{
      const who=el('div',{className:'who',textContent:`${[m.first_name,m.last_name].filter(Boolean).join(' ')||m.email} · ${m.role}${m.status==='invited'?' · invited':''}`},el('small',{textContent:m.email}));
      const canRemove=d.role==='owner'||m.role!=='admin';
      const row=el('div',{className:'review-signer'},el('span',{className:'order',textContent:m.status==='invited'?'✉':'✓'}),who);
      if(canRemove){const rm=el('button',{className:'btn btn-ghost',type:'button',textContent:m.status==='invited'?'Cancel invite':'Remove',style:'font-size:.75rem;color:var(--red)'});rm.onclick=async()=>{if(!confirm(`Remove ${m.email} from the team?`))return;try{await teamCall(`/members/${m.id}`,{method:'DELETE'});loadTeam();}catch(err){showResult(teamResult,'error',err.message);}};row.append(rm);}
      list.append(row);
    });
    teamBody.append(list);
    if(d.team.used<d.team.seats){
      const email=el('input',{className:'form-input',type:'email',placeholder:'colleague@company.com',style:'flex:1 1 220px'});
      const role=el('select',{className:'form-input',style:'width:auto'},el('option',{value:'member',textContent:'Member'}));
      if(d.role==='owner')role.append(el('option',{value:'admin',textContent:'Admin (can invite)'}));
      const invite=el('button',{className:'btn btn-primary',type:'button',textContent:'Send invite'});
      invite.onclick=async()=>{invite.disabled=true;try{const r=await teamCall('/invite',{method:'POST',body:JSON.stringify({email:email.value.trim(),role:role.value})});showResult(teamResult,r.warning?'info':'success',r.warning||`Invitation sent to ${email.value.trim()}.`);loadTeam();}catch(err){showResult(teamResult,'error',err.message);}finally{invite.disabled=false;}};
      teamBody.append(el('div',{className:'row',style:'display:flex;gap:.5rem;flex-wrap:wrap'},email,role,invite));
    }else teamBody.append(el('p',{style:'margin:0;color:var(--text3)'},'All seats are in use. ',el('a',{href:'contact.html',textContent:'Contact us to add seats'}),'.'));
  }
  document.addEventListener('nyx:panel-changed',e=>{if(e.detail?.panel==='account')loadTeam();});
  // Invitation links: dashboard.html?team_invite=<token>#account
  const inviteToken=new URLSearchParams(location.search).get('team_invite');
  if(inviteToken){
    const acceptInvite=async()=>{
      try{const r=await teamCall('/accept',{method:'POST',body:JSON.stringify({token:inviteToken})});toast(`Welcome to ${r.team}! Professional access is on.`,'success');history.replaceState(null,'',location.pathname+'#account');setTimeout(()=>location.reload(),1500);}
      catch(err){toast(err.message,'error');history.replaceState(null,'',location.pathname+'#account');}
    };
    const waitReady=setInterval(()=>{if(window.__nyxDashboardReady&&auth.currentUser){clearInterval(waitReady);acceptInvite();}},300);
  }

  // Branding
  const brandResult=document.getElementById('brand-result'),brandPreview=document.getElementById('brand-logo-preview'),brandRemove=document.getElementById('brand-logo-remove');
  let brandLogo; // undefined = keep, null = remove, string = new data URL
  async function loadBrand(){
    try{const token=await auth.currentUser.getIdToken();const res=await fetch(`${API}/api/user/brand`,{headers:{Authorization:`Bearer ${token}`}});const d=await res.json();if(!res.ok)return;
      document.getElementById('brand-name').value=d.name||'';brandLogo=undefined;
      if(d.logoUrl){brandPreview.src=API+d.logoUrl;brandPreview.style.display='';brandRemove.style.display='';}else{brandPreview.style.display='none';brandRemove.style.display='none';}
    }catch(_){}
  }
  document.getElementById('brand-logo-file').addEventListener('change',function(){
    const f=this.files[0];if(!f)return;
    if(!/^image\/(png|jpeg)$/.test(f.type))return showResult(brandResult,'error','Choose a PNG or JPG image.');
    if(f.size>200*1024)return showResult(brandResult,'error','That image is over 200 KB. Try a smaller version.');
    const reader=new FileReader();reader.onload=()=>{brandLogo=reader.result;brandPreview.src=brandLogo;brandPreview.style.display='';brandRemove.style.display='';};reader.readAsDataURL(f);
  });
  brandRemove.addEventListener('click',()=>{brandLogo=null;brandPreview.style.display='none';brandRemove.style.display='none';document.getElementById('brand-logo-file').value='';});
  document.getElementById('brand-save').addEventListener('click',async function(){
    this.disabled=true;
    try{const token=await auth.currentUser.getIdToken();const body={name:document.getElementById('brand-name').value.trim()};if(brandLogo!==undefined)body.logo=brandLogo;
      const res=await fetch(`${API}/api/user/brand`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(body)});const d=await res.json().catch(()=>({}));if(!res.ok)throw new Error(d.error||'Could not save branding.');
      showResult(brandResult,'success','Branding saved. It appears on your next signature request.');loadBrand();
    }catch(err){showResult(brandResult,'error',err.message);}finally{this.disabled=false;}
  });
  document.addEventListener('nyx:panel-changed',e=>{if(e.detail?.panel==='account')loadBrand();});
  const dataResult=document.getElementById('acc-data-result');
  document.getElementById('acc-export-btn').addEventListener('click',async function(){
    this.disabled=true;
    try{
      const token=await auth.currentUser.getIdToken();
      const res=await fetch(`${API}/api/user/export`,{headers:{Authorization:`Bearer ${token}`}});
      if(!res.ok){const d=await res.json().catch(()=>({}));throw new Error(d.error||'Could not export your data.');}
      triggerDownload(await res.blob(),'nyxprism-my-data.json');
      showResult(dataResult,'success','Your data was downloaded as nyxprism-my-data.json.');
    }catch(err){showResult(dataResult,'error',err.message);}finally{this.disabled=false;}
  });
  const deleteBox=document.getElementById('acc-delete-box');
  document.getElementById('acc-delete-open').addEventListener('click',()=>{deleteBox.style.display='block';document.getElementById('acc-delete-confirm').focus();});
  document.getElementById('acc-delete-cancel').addEventListener('click',()=>{deleteBox.style.display='none';document.getElementById('acc-delete-confirm').value='';});
  document.getElementById('acc-delete-btn').addEventListener('click',async function(){
    const confirmEmail=document.getElementById('acc-delete-confirm').value.trim();
    if(confirmEmail.toLowerCase()!==(auth.currentUser.email||'').toLowerCase())return showResult(dataResult,'error','Type your email address exactly to confirm.');
    this.disabled=true;
    try{
      const token=await auth.currentUser.getIdToken();
      const res=await fetch(`${API}/api/user/account`,{method:'DELETE',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({confirmEmail})});
      const d=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(d.error||'Could not delete your account.');
      await signOut(auth).catch(()=>{});
      window.location.replace('index.html?account=deleted');
    }catch(err){showResult(dataResult,'error',err.message);this.disabled=false;}
  });
  document.getElementById('acc-change-email').addEventListener('click',async function(){
    const newEmail=document.getElementById('acc-new-email').value.trim();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail))return showResult(securityResult,'error','Enter a valid new email address.');
    this.disabled=true;
    try{
      await reauth();await verifyBeforeUpdateEmail(auth.currentUser,newEmail);
      document.getElementById('acc-new-email').value='';document.getElementById('acc-current-password').value='';
      showResult(securityResult,'success','Verification link sent to '+newEmail+'. Your email changes after you confirm it, then sign in with the new address.');
    }catch(err){showResult(securityResult,'error',friendlyAuthError(err));}finally{this.disabled=false;}
  });
  const themeBtns=document.querySelectorAll('#acc-theme-choices .choice-btn');
  const wallBtns=document.querySelectorAll('#acc-wallpaper-choices .choice-btn');
  const accentBtns=document.querySelectorAll('#acc-accent-choices .accent-swatch');
  function mark(list,attr,value){list.forEach(b=>b.classList.toggle('active',b.dataset[attr]===value));}
  function syncMarks(){
    mark(themeBtns,'theme',document.body.classList.contains('light')?'light':'dark');
    mark(wallBtns,'wallpaper',localStorage.getItem('nyx_wallpaper')||'prism');
    mark(accentBtns,'accent',localStorage.getItem('nyx_accent')||'violet');
  }
  themeBtns.forEach(b=>b.addEventListener('click',()=>{const mode=b.dataset.theme;document.body.classList.toggle('light',mode==='light');localStorage.setItem('nyx_theme',mode);mark(themeBtns,'theme',mode);}));
  wallBtns.forEach(b=>b.addEventListener('click',()=>{window.__nyxSetWallpaper?.(b.dataset.wallpaper);mark(wallBtns,'wallpaper',b.dataset.wallpaper);}));
  accentBtns.forEach(b=>b.addEventListener('click',()=>{window.__nyxApplyAccent?.(b.dataset.accent);mark(accentBtns,'accent',b.dataset.accent);}));
  syncMarks();
  document.addEventListener('nyx:panel-changed',e=>{if(e.detail&&e.detail.panel==='account')syncMarks();});
})();

const avatar=document.getElementById('nav-avatar');
document.addEventListener('click',e=>{if(avatar.contains(e.target)){avatar.classList.toggle('open');}else{avatar.classList.remove('open');}});

function switchPanel(name){
  window.__nyxCurrentPanel=name;
  if(window.__nyxBlocked&&!['home','account','apikeys'].includes(name)){document.getElementById('upgrade-modal').style.display='flex';return;}
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
  const panel=document.getElementById('panel-'+name);
  if(panel)panel.classList.add('active');
  document.querySelectorAll(`[data-panel="${name}"]`).forEach(b=>b.classList.add('active'));
  window.scrollTo(0,0);
  if(history.replaceState)history.replaceState(null,'',name==='home'?location.pathname+location.search:'#'+name);
  document.dispatchEvent(new CustomEvent('nyx:panel-changed',{detail:{panel:name}}));
}
document.querySelectorAll('[data-panel]').forEach(btn=>btn.addEventListener('click',()=>switchPanel(btn.dataset.panel)));
document.querySelectorAll('[data-launch]').forEach(card=>card.addEventListener('click',()=>switchPanel(card.dataset.launch)));

function escapeHtml(value){return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}

function toast(msg,type='success'){
  const t=document.createElement('div');t.className=`toast ${type}`;
  t.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${type==='success'?'<polyline points="20 6 9 17 4 12"/>':`<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>`}</svg><span>${escapeHtml(msg)}</span>`;
  document.getElementById('toast-container').appendChild(t);
  setTimeout(()=>t.remove(),3500);
}

function fmtSize(b){if(b<1024)return b+' B';if(b<1048576)return (b/1024).toFixed(1)+' KB';return (b/1048576).toFixed(1)+' MB';}

function renderFileItem(file,onRemove){
  const el=document.createElement('div');el.className='file-item';
  var isPdf=file.name.toLowerCase().endsWith('.pdf');
  el.innerHTML='<span class="fthumb"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>' +
    '<span class="fname">' + escapeHtml(file.name) + '</span>' +
    (isPdf ? '<span class="fchip-pages">…</span>' : '') +
    '<span class="fsize">' + fmtSize(file.size) + '</span>' +
    '<button class="fremove" title="Remove"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>';
  el.querySelector('.fremove').addEventListener('click',()=>{el.remove();onRemove();});
  if(isPdf){
    loadPdfjsLib().then(function(pdfjsLib){
      return file.arrayBuffer().then(function(ab){
        return pdfjsLib.getDocument({data:new Uint8Array(ab)}).promise;
      }).then(function(pdf){
        var badge=el.querySelector('.fchip-pages');
        if(badge) badge.textContent=pdf.numPages+'p';
        return pdf.getPage(1);
      }).then(function(page){
        var vp=page.getViewport({scale:0.2});
        var cv=document.createElement('canvas');cv.width=vp.width;cv.height=vp.height;
        cv.style.cssText='width:100%;height:100%;display:block;border-radius:3px';
        return page.render({canvasContext:cv.getContext('2d'),viewport:vp}).promise.then(function(){ return cv; });
      }).then(function(cv){
        var thumb=el.querySelector('.fthumb');
        if(thumb){thumb.innerHTML='';thumb.appendChild(cv);}
      });
    }).catch(function(){});
  }
  return el;
}

function showResult(el,type,msg){
  const icons={success:'<polyline points="20 6 9 17 4 12"/>',error:'<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',info:'<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'};
  el.className=`result-box ${type} visible`;
  el.style.display='';// inline display:none in the markup would otherwise keep the message hidden
  el.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[type]}</svg><div class="rtext">${escapeHtml(msg)}</div>`;
}

function triggerDownload(blob,filename){
  const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),3000);
  // Let recent files, confetti and cloud saving react to every download.
  document.dispatchEvent(new CustomEvent('nyx:download',{detail:{blob,filename}}));
}
window.toast=toast;

function setupDrop(dropEl,input,onFiles){
  dropEl.addEventListener('dragover',e=>{e.preventDefault();dropEl.classList.add('drag-over');});
  dropEl.addEventListener('dragleave',()=>dropEl.classList.remove('drag-over'));
  // Accept what the file picker accepts (PDFs unless it says images), whatever the letter case.
  const wantsImages=/image/i.test(input.accept||'');
  const accepts=f=>wantsImages?(/^image\//.test(f.type)||/\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(f.name)):(f.type==='application/pdf'||/\.pdf$/i.test(f.name));
  dropEl.addEventListener('drop',e=>{
    e.preventDefault();dropEl.classList.remove('drag-over');
    const all=[...e.dataTransfer.files];let files=all.filter(accepts);
    if(!files.length){if(all.length)toast(wantsImages?'Drop image files (PNG, JPG…).':'Drop a PDF file.','error');return;}
    if(!input.multiple)files=files.slice(0,1);
    // Tools that read input.files (not the callback) need the dropped files there too.
    try{const dt=new DataTransfer();files.forEach(f=>dt.items.add(f));input.files=dt.files;}catch(_){}
    onFiles(files);
  });
  input.addEventListener('change',()=>{if(input.files.length)onFiles([...input.files]);});
}

async function loadPdfLib(){
  if(window.PDFLib)return window.PDFLib;
  return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='https://unpkg.com/@cantoo/pdf-lib/dist/pdf-lib.min.js';s.onload=()=>resolve(window.PDFLib);s.onerror=reject;document.head.appendChild(s);});
}
async function loadPdfjsLib(){
  if(window.pdfjsLib)return window.pdfjsLib;
  return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';s.onload=()=>{window.pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';resolve(window.pdfjsLib);};s.onerror=reject;document.head.appendChild(s);});
}
async function loadTesseract(){
  if(window.Tesseract)return window.Tesseract;
  return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='https://unpkg.com/tesseract.js@5/dist/tesseract.min.js';s.onload=()=>resolve(window.Tesseract);s.onerror=reject;document.head.appendChild(s);});
}
async function loadQRCode(){
  if(window.QRCode)return window.QRCode;
  return new Promise((resolve,reject)=>{
    const s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js';
    s.onload=()=>resolve(window.QRCode);
    s.onerror=reject;
    document.head.appendChild(s);
  });
}

// SPLIT
{
  let splitFile=null;
  const dropEl=document.getElementById('split-drop'),input=document.getElementById('split-file'),listEl=document.getElementById('split-file-list'),optsEl=document.getElementById('split-options'),resultEl=document.getElementById('split-result'),modeEl=document.getElementById('split-mode');
  function setFile(file){splitFile=file;listEl.innerHTML='';listEl.appendChild(renderFileItem(file,()=>{splitFile=null;optsEl.style.display='none';resultEl.className='result-box';}));optsEl.style.display='block';}
  setupDrop(dropEl,input,f=>setFile(f[0]));
  modeEl.addEventListener('change',()=>{document.getElementById('split-every-opts').style.display=modeEl.value==='every'?'block':'none';document.getElementById('split-ranges-opts').style.display=modeEl.value==='ranges'?'block':'none';});
  document.getElementById('add-range').addEventListener('click',()=>{const row=document.createElement('div');row.className='range-row';row.innerHTML=`<input class="form-input" type="number" placeholder="From" min="1" /><span class="range-dash">-</span><input class="form-input" type="number" placeholder="To" min="1" /><button class="fremove"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;row.querySelector('.fremove').addEventListener('click',()=>row.remove());document.getElementById('range-list').appendChild(row);});
  document.getElementById('split-run').addEventListener('click',async()=>{
    if(!splitFile)return toast('Select a PDF first','error');
    const btn=document.getElementById('split-run');btn.disabled=true;btn.textContent='Processing…';
    try{
      const{PDFDocument}=await loadPdfLib();const srcBytes=await splitFile.arrayBuffer();const srcDoc=await PDFDocument.load(srcBytes);const total=srcDoc.getPageCount();const mode=modeEl.value;let ranges=[];
      if(mode==='every'){const n=parseInt(document.getElementById('split-n').value)||1;for(let i=0;i<total;i+=n)ranges.push([i,Math.min(i+n-1,total-1)]);}
      else if(mode==='extract'){for(let i=0;i<total;i++)ranges.push([i,i]);}
      else{const rows=document.querySelectorAll('#range-list .range-row');rows.forEach(row=>{const inputs=row.querySelectorAll('input');const from=parseInt(inputs[0].value)-1;const to=parseInt(inputs[1].value)-1;if(!isNaN(from)&&!isNaN(to)&&from>=0&&to<total&&from<=to)ranges.push([from,to]);});if(!ranges.length){toast('Add at least one valid range','error');btn.disabled=false;btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Split PDF';return;}}
      const stem=splitFile.name.replace('.pdf','');
      for(let i=0;i<ranges.length;i++){const[from,to]=ranges[i];const newDoc=await PDFDocument.create();const pages=await newDoc.copyPages(srcDoc,Array.from({length:to-from+1},(_,k)=>from+k));pages.forEach(p=>newDoc.addPage(p));const bytes=await newDoc.save();triggerDownload(new Blob([bytes],{type:'application/pdf'}),`${stem}_part${i+1}.pdf`);}
      Stats.inc(0);showResult(resultEl,'success',`Split into ${ranges.length} file${ranges.length!==1?'s':''} - downloading now.`);toast(`Split complete - ${ranges.length} files`);
    }catch(err){showResult(resultEl,'error','Error: '+err.message);toast(err.message,'error');}
    btn.disabled=false;btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Split PDF';
  });
  document.getElementById('split-clear').addEventListener('click',()=>{splitFile=null;listEl.innerHTML='';optsEl.style.display='none';resultEl.className='result-box';input.value='';});
}

// MERGE
{
  let mergeFiles=[];
  const dropEl=document.getElementById('merge-drop'),input=document.getElementById('merge-files'),listEl=document.getElementById('merge-file-list'),optsEl=document.getElementById('merge-options'),resultEl=document.getElementById('merge-result');
  function addFiles(files){files.forEach(f=>{mergeFiles.push(f);listEl.appendChild(renderFileItem(f,()=>{mergeFiles=mergeFiles.filter(x=>x!==f);if(!mergeFiles.length)optsEl.style.display='none';}));});optsEl.style.display=mergeFiles.length?'block':'none';}
  setupDrop(dropEl,input,addFiles);
  document.getElementById('merge-run').addEventListener('click',async()=>{
    if(mergeFiles.length<1)return toast('Add at least one PDF','error');
    const btn=document.getElementById('merge-run');btn.disabled=true;btn.textContent='Merging…';
    try{
      const{PDFDocument}=await loadPdfLib();const merged=await PDFDocument.create();
      for(const f of mergeFiles){const bytes=await f.arrayBuffer();const src=await PDFDocument.load(bytes);const pages=await merged.copyPages(src,src.getPageIndices());pages.forEach(p=>merged.addPage(p));}
      const outBytes=await merged.save();const name=document.getElementById('merge-output-name').value||'merged.pdf';
      const origSize=mergeFiles.reduce((s,f)=>s+f.size,0);
      triggerDownload(new Blob([outBytes],{type:'application/pdf'}),name.endsWith('.pdf')?name:name+'.pdf');
      Stats.inc(Math.round((origSize-outBytes.byteLength)/1048576*10)/10);
      showResult(resultEl,'success',`Merged ${mergeFiles.length} PDFs into ${name}`);toast('Merge complete!');
    }catch(err){showResult(resultEl,'error','Error: '+err.message);toast(err.message,'error');}
    btn.disabled=false;btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Merge PDFs';
  });
  document.getElementById('merge-clear').addEventListener('click',()=>{mergeFiles=[];listEl.innerHTML='';optsEl.style.display='none';resultEl.className='result-box';input.value='';});
}

// COMPRESS
{
  let cFile=null;
  const dropEl=document.getElementById('compress-drop'),input=document.getElementById('compress-file'),listEl=document.getElementById('compress-file-list'),optsEl=document.getElementById('compress-options'),resultEl=document.getElementById('compress-result');
  document.getElementById('compress-quality').addEventListener('input',e=>document.getElementById('quality-val').textContent=e.target.value);
  setupDrop(dropEl,input,f=>{cFile=f[0];listEl.innerHTML='';listEl.appendChild(renderFileItem(cFile,()=>{cFile=null;optsEl.style.display='none';resultEl.className='result-box';}));optsEl.style.display='block';});
  document.getElementById('compress-run').addEventListener('click',async()=>{
    if(!cFile)return toast('Select a PDF first','error');
    const btn=document.getElementById('compress-run');btn.disabled=true;btn.textContent='Compressing…';
    try{
      const{PDFDocument}=await loadPdfLib();const bytes=await cFile.arrayBuffer();const doc=await PDFDocument.load(bytes,{updateMetadata:false});
      const out=await doc.save({useObjectStreams:true});
      const pct=Math.round((1-out.byteLength/bytes.byteLength)*100);
      triggerDownload(new Blob([out],{type:'application/pdf'}),cFile.name.replace('.pdf','_compressed.pdf'));
      Stats.inc(Math.max(0,Math.round((bytes.byteLength-out.byteLength)/1048576*10)/10));
      showResult(resultEl,'success',`${fmtSize(bytes.byteLength)} → ${fmtSize(out.byteLength)} (${pct>=0?pct+'% smaller':'already optimized'})`);
      toast('Compression complete!');
    }catch(err){showResult(resultEl,'error','Error: '+err.message);toast(err.message,'error');}
    btn.disabled=false;btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Compress PDF';
  });
  document.getElementById('compress-clear').addEventListener('click',()=>{cFile=null;listEl.innerHTML='';optsEl.style.display='none';resultEl.className='result-box';input.value='';});
}

// WATERMARK
{
  let wmFile=null;
  const dropEl=document.getElementById('wm-drop'),input=document.getElementById('wm-file'),listEl=document.getElementById('wm-file-list'),optsEl=document.getElementById('wm-options'),resultEl=document.getElementById('wm-result');
  document.getElementById('wm-opacity').addEventListener('input',e=>document.getElementById('opacity-val').textContent=e.target.value);
  document.getElementById('wm-fontsize').addEventListener('input',e=>document.getElementById('fontsize-val').textContent=e.target.value);
  document.getElementById('wm-angle').addEventListener('input',e=>document.getElementById('angle-val').textContent=e.target.value);
  setupDrop(dropEl,input,f=>{wmFile=f[0];listEl.innerHTML='';listEl.appendChild(renderFileItem(wmFile,()=>{wmFile=null;optsEl.style.display='none';resultEl.className='result-box';}));optsEl.style.display='block';});
  document.getElementById('wm-run').addEventListener('click',async()=>{
    if(!wmFile)return toast('Select a PDF first','error');
    const text=document.getElementById('wm-text').value.trim();if(!text)return toast('Enter watermark text','error');
    const opacity=parseFloat(document.getElementById('wm-opacity').value)/100;const fontSize=parseInt(document.getElementById('wm-fontsize').value);const angleDeg=parseFloat(document.getElementById('wm-angle').value);
    const btn=document.getElementById('wm-run');btn.disabled=true;btn.textContent='Applying…';
    try{
      const{PDFDocument,rgb,degrees}=await loadPdfLib();const bytes=await wmFile.arrayBuffer();const pdfDoc=await PDFDocument.load(bytes);const pages=pdfDoc.getPages();
      for(const page of pages){const{width,height}=page.getSize();page.drawText(text,{x:width/2-(text.length*fontSize*0.3),y:height/2,size:fontSize,color:rgb(0.5,0.5,0.5),opacity,rotate:degrees(angleDeg)});}
      const out=await pdfDoc.save();triggerDownload(new Blob([out],{type:'application/pdf'}),wmFile.name.replace('.pdf','_watermarked.pdf'));
      Stats.inc(0);showResult(resultEl,'success',`Watermark "${text}" applied to ${pages.length} page${pages.length!==1?'s':''}.`);toast('Watermark applied!');
    }catch(err){showResult(resultEl,'error','Error: '+err.message);toast(err.message,'error');}
    btn.disabled=false;btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Apply Watermark';
  });
  document.getElementById('wm-clear').addEventListener('click',()=>{wmFile=null;listEl.innerHTML='';optsEl.style.display='none';resultEl.className='result-box';input.value='';});
}

// PROTECT
{
  let pFile=null;
  const dropEl=document.getElementById('protect-drop'),input=document.getElementById('protect-file'),listEl=document.getElementById('protect-file-list'),optsEl=document.getElementById('protect-options'),resultEl=document.getElementById('protect-result');
  setupDrop(dropEl,input,f=>{pFile=f[0];listEl.innerHTML='';listEl.appendChild(renderFileItem(pFile,()=>{pFile=null;optsEl.style.display='none';resultEl.className='result-box';}));optsEl.style.display='block';});
  document.getElementById('protect-run').addEventListener('click',async()=>{
    if(!pFile)return toast('Select a PDF first','error');
    const pass=document.getElementById('protect-pass').value.trim();if(!pass)return toast('Enter a password','error');
    const owner=document.getElementById('protect-owner').value.trim()||pass;
    const btn=document.getElementById('protect-run');btn.disabled=true;btn.innerHTML='<span class="inline-spinner"></span>Encrypting…';
    try{
      const{PDFDocument}=await loadPdfLib();
      const bytes=await pFile.arrayBuffer();
      const pdfDoc=await PDFDocument.load(bytes);
      const out=await pdfDoc.save({
        encryption:{
          userPassword:pass,
          ownerPassword:owner,
          permissions:{printing:'highResolution',modifying:false,copying:false,annotating:false,fillingForms:false,contentAccessibility:true,documentAssembly:false}
        }
      });
      triggerDownload(new Blob([out],{type:'application/pdf'}),pFile.name.replace(/\.pdf$/i,'_protected.pdf'));
      showResult(resultEl,'success',`PDF protected - password-encrypted and ready to download.`);
      toast('PDF protected!');
    }catch(err){showResult(resultEl,'error','Encryption error: '+err.message);toast(err.message,'error');}
    btn.disabled=false;btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg> Protect PDF';
  });
  document.getElementById('protect-clear').addEventListener('click',()=>{pFile=null;listEl.innerHTML='';optsEl.style.display='none';resultEl.className='result-box';input.value='';});
}

// EXTRACT TEXT
{
  let eFile=null;
  const dropEl=document.getElementById('extract-drop'),input=document.getElementById('extract-file'),listEl=document.getElementById('extract-file-list'),optsEl=document.getElementById('extract-options'),resultEl=document.getElementById('extract-result'),outputEl=document.getElementById('extract-output'),textEl=document.getElementById('extract-text');
  setupDrop(dropEl,input,f=>{eFile=f[0];listEl.innerHTML='';listEl.appendChild(renderFileItem(eFile,()=>{eFile=null;optsEl.style.display='none';resultEl.className='result-box';outputEl.style.display='none';}));optsEl.style.display='block';});
  document.getElementById('extract-run').addEventListener('click',async()=>{
    if(!eFile)return toast('Select a PDF first','error');
    const btn=document.getElementById('extract-run');btn.disabled=true;btn.textContent='Extracting…';outputEl.style.display='none';
    try{
      const pdfjs=await loadPdfjsLib();const bytes=await eFile.arrayBuffer();const pdf=await pdfjs.getDocument({data:bytes}).promise;let fullText='';
      for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i);const content=await page.getTextContent();const pageText=content.items.map(it=>it.str).join(' ');fullText+=`--- Page ${i} ---\n${pageText}\n\n`;}
      if(!fullText.trim()){showResult(resultEl,'info','No readable text found. This may be a scanned PDF - try OCR instead.');}
      else{textEl.textContent=fullText;outputEl.style.display='block';showResult(resultEl,'success',`Extracted text from ${pdf.numPages} page${pdf.numPages!==1?'s':''}.`);Stats.inc(0);}
    }catch(err){showResult(resultEl,'error','Error: '+err.message);toast(err.message,'error');}
    btn.disabled=false;btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Extract Text';
  });
  document.getElementById('extract-copy').addEventListener('click',()=>{navigator.clipboard.writeText(textEl.textContent).then(()=>toast('Copied to clipboard!'));});
  document.getElementById('extract-download').addEventListener('click',()=>{triggerDownload(new Blob([textEl.textContent],{type:'text/plain'}),(eFile?.name||'extracted').replace('.pdf','')+'.txt');});
  document.getElementById('extract-clear').addEventListener('click',()=>{eFile=null;listEl.innerHTML='';optsEl.style.display='none';resultEl.className='result-box';outputEl.style.display='none';input.value='';});
}

// OCR
{
  let oFile=null,ocrText='';
  const dropEl=document.getElementById('ocr-drop'),input=document.getElementById('ocr-file'),listEl=document.getElementById('ocr-file-list'),optsEl=document.getElementById('ocr-options'),resultEl=document.getElementById('ocr-result'),textWrap=document.getElementById('ocr-text-wrap'),textOut=document.getElementById('ocr-text-out'),dlBtn=document.getElementById('ocr-download-txt');
  const ocrWrap=document.getElementById('ocr-progress'),ocrBar=document.getElementById('ocr-bar'),ocrStat=document.getElementById('ocr-status');
  setupDrop(dropEl,input,f=>{oFile=f[0];listEl.innerHTML='';listEl.appendChild(renderFileItem(oFile,()=>{oFile=null;optsEl.style.display='none';resultEl.className='result-box';textWrap.style.display='none';dlBtn.style.display='none';ocrText='';}));optsEl.style.display='block';});
  document.getElementById('ocr-run').addEventListener('click',async()=>{
    if(!oFile)return toast('Select a PDF first','error');
    const btn=document.getElementById('ocr-run');btn.disabled=true;btn.innerHTML='<span class="inline-spinner"></span>Loading OCR engine…';
    textWrap.style.display='none';dlBtn.style.display='none';ocrText='';resultEl.className='result-box';
    try{
      const scale=parseFloat(document.getElementById('ocr-dpi').value)||2;
      const lang=document.getElementById('ocr-lang').value;
      const pdfjs=await loadPdfjsLib();
      const bytes=await oFile.arrayBuffer();
      const pdf=await pdfjs.getDocument({data:new Uint8Array(bytes)}).promise;
      const Tesseract=await loadTesseract();
      btn.innerHTML='<span class="inline-spinner"></span>Starting OCR engine…';
      const worker=await Tesseract.createWorker(lang,1,{
        workerPath:'https://unpkg.com/tesseract.js@5/dist/worker.min.js',
        corePath:'https://unpkg.com/tesseract.js-core@5/tesseract-core-simd-lstm.wasm.js',
        langPath:'https://tessdata.projectnaptha.com/4.0.0_best',
      });
      const lines=[];
      for(let i=1;i<=pdf.numPages;i++){
        btn.innerHTML=`<span class="inline-spinner"></span>OCR page ${i}/${pdf.numPages}…`;
        ocrWrap.style.display='block';ocrBar.style.width=Math.round(i/pdf.numPages*100)+'%';ocrStat.textContent='Page '+i+' of '+pdf.numPages;
        const page=await pdf.getPage(i);const vp=page.getViewport({scale});
        const canvas=document.createElement('canvas');canvas.width=vp.width;canvas.height=vp.height;
        await page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise;
        const{data:{text}}=await worker.recognize(canvas);
        if(pdf.numPages>1)lines.push(`--- Page ${i} ---`);
        lines.push(text.trim());
      }
      await worker.terminate();
      ocrText=lines.join('\n\n');
      textOut.value=ocrText;textWrap.style.display='block';dlBtn.style.display='';
      Stats.inc(0);
      showResult(resultEl,'success',`OCR complete - ${pdf.numPages} page${pdf.numPages!==1?'s':''} processed.`);
      toast('OCR complete!');
    }catch(err){showResult(resultEl,'error','OCR error: '+err.message);toast(err.message,'error');}
    btn.disabled=false;btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"/><rect x="7" y="7" width="10" height="10"/></svg> Run OCR';
  });
  document.getElementById('ocr-download-txt').addEventListener('click',()=>{if(!ocrText)return;triggerDownload(new Blob([ocrText],{type:'text/plain'}),oFile.name.replace(/\.pdf$/i,'.txt'));});
  document.getElementById('ocr-clear').addEventListener('click',()=>{oFile=null;listEl.innerHTML='';optsEl.style.display='none';resultEl.className='result-box';textWrap.style.display='none';dlBtn.style.display='none';ocrText='';input.value='';});
}

// ROTATE
{
  let rFile=null;
  const dropEl=document.getElementById('rotate-drop'),input=document.getElementById('rotate-file'),listEl=document.getElementById('rotate-file-list'),optsEl=document.getElementById('rotate-options'),resultEl=document.getElementById('rotate-result'),scopeEl=document.getElementById('rotate-scope');
  scopeEl.addEventListener('change',()=>{document.getElementById('rotate-pages-row').style.display=scopeEl.value==='specific'?'block':'none';});
  setupDrop(dropEl,input,f=>{rFile=f[0];listEl.innerHTML='';listEl.appendChild(renderFileItem(rFile,()=>{rFile=null;optsEl.style.display='none';resultEl.className='result-box';}));optsEl.style.display='block';});
  document.getElementById('rotate-run').addEventListener('click',async()=>{
    if(!rFile)return toast('Select a PDF first','error');
    const btn=document.getElementById('rotate-run');btn.disabled=true;btn.textContent='Rotating…';
    try{
      const{PDFDocument,degrees}=await loadPdfLib();const bytes=await rFile.arrayBuffer();const pdfDoc=await PDFDocument.load(bytes);const pages=pdfDoc.getPages();const deg=parseInt(document.getElementById('rotate-degrees').value);
      let targetIdxs=pages.map((_,i)=>i);
      if(scopeEl.value==='specific'){const raw=document.getElementById('rotate-pages').value;targetIdxs=[];raw.split(',').forEach(part=>{const p=part.trim();if(p.includes('-')){const[a,b]=p.split('-').map(x=>parseInt(x)-1);for(let i=a;i<=b;i++)if(i>=0&&i<pages.length)targetIdxs.push(i);}else{const n=parseInt(p)-1;if(n>=0&&n<pages.length)targetIdxs.push(n);}});}
      targetIdxs.forEach(i=>pages[i].setRotation(degrees((pages[i].getRotation().angle+deg)%360)));
      const out=await pdfDoc.save();triggerDownload(new Blob([out],{type:'application/pdf'}),rFile.name.replace('.pdf','_rotated.pdf'));
      Stats.inc(0);showResult(resultEl,'success',`Rotated ${targetIdxs.length} page${targetIdxs.length!==1?'s':''} by ${deg}&deg;.`);toast('Rotation complete!');
    }catch(err){showResult(resultEl,'error','Error: '+err.message);toast(err.message,'error');}
    btn.disabled=false;btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Rotate PDF';
  });
  document.getElementById('rotate-clear').addEventListener('click',()=>{rFile=null;listEl.innerHTML='';optsEl.style.display='none';resultEl.className='result-box';input.value='';});
}

// API KEYS
{
  const listEl=document.getElementById('apikey-list');
  const createBtn=document.getElementById('apikey-create-btn');
  const revealModal=document.getElementById('apikey-reveal-modal');
  const revealValue=document.getElementById('apikey-reveal-value');
  const revealCopy=document.getElementById('apikey-reveal-copy');
  const revealClose=document.getElementById('apikey-reveal-close');

  function fmtDate(iso){return iso?new Date(iso).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}):'Never';}

  async function loadKeys(){
    listEl.innerHTML='<div style="color:var(--muted);font-size:.85rem">Loading…</div>';
    try{
      const tok=await window.__nyxGetToken();
      const r=await fetch(API+'/api/keys',{headers:{Authorization:'Bearer '+tok}});
      const d=await r.json();
      if(!r.ok){listEl.innerHTML='<div style="color:var(--red);font-size:.85rem">'+d.error+'</div>';return;}
      if(!d.keys.length){listEl.innerHTML='<div style="color:var(--muted);font-size:.85rem">No API keys yet. Create one above.</div>';return;}
      listEl.innerHTML='';
      d.keys.forEach(k=>{
        const row=document.createElement('div');
        row.style.cssText='display:flex;align-items:center;gap:.75rem;padding:.65rem 0;border-bottom:1px solid var(--border2);';
        row.innerHTML=`
          <div style="flex:1;min-width:0">
            <div style="font-size:.875rem;font-weight:600;color:var(--text);margin-bottom:.15rem">${k.label}</div>
            <div style="font-family:monospace;font-size:.8rem;color:var(--muted)">${k.key_prefix}••••••••••••••••••••••••</div>
            <div style="font-size:.72rem;color:var(--muted2);margin-top:.1rem">Created ${fmtDate(k.created_at)} · Last used ${fmtDate(k.last_used_at)}</div>
          </div>
          <button class="btn btn-sm" style="background:rgba(239,68,68,.1);color:var(--red);border:1px solid rgba(239,68,68,.25);flex-shrink:0" data-revoke="${k.id}">Revoke</button>`;
        listEl.appendChild(row);
      });
      listEl.querySelectorAll('[data-revoke]').forEach(btn=>btn.addEventListener('click',async()=>{
        if(!confirm('Revoke this key? Any applications using it will lose access immediately.'))return;
        btn.disabled=true;btn.textContent='Revoking…';
        try{
          const tok=await window.__nyxGetToken();
          const r=await fetch(API+'/api/keys/'+btn.dataset.revoke,{method:'DELETE',headers:{Authorization:'Bearer '+tok}});
          const d=await r.json();
          if(!r.ok){toast(d.error,'error');}else{toast('API key revoked.');loadKeys();}
        }catch(e){toast('Failed to revoke key.','error');}
      }));
    }catch(e){listEl.innerHTML='<div style="color:var(--red);font-size:.85rem">Failed to load keys.</div>';}
  }

  createBtn.addEventListener('click',async()=>{
    const label=(document.getElementById('apikey-label').value||'').trim()||'My API Key';
    createBtn.disabled=true;createBtn.textContent='Generating…';
    try{
      const tok=await window.__nyxGetToken();
      const r=await fetch(API+'/api/keys',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tok},body:JSON.stringify({label})});
      const d=await r.json();
      if(!r.ok){toast(d.error,'error');}else{
        document.getElementById('apikey-label').value='';
        revealValue.textContent=d.key;
        revealModal.style.display='flex';
        loadKeys();
      }
    }catch(e){toast('Failed to create key.','error');}
    createBtn.disabled=false;createBtn.textContent='Generate Key';
  });

  revealCopy.addEventListener('click',()=>{navigator.clipboard.writeText(revealValue.textContent).then(()=>toast('Key copied!'));});
  revealClose.addEventListener('click',()=>{revealModal.style.display='none';});
  revealModal.addEventListener('click',e=>{if(e.target===revealModal)revealModal.style.display='none';});

  // Load keys when panel is opened
  const origSwitch=window.__switchPanelHook;
  document.addEventListener('nyx:panel-changed',e=>{if(e.detail==='apikeys')loadKeys();});
}


// AI SMART SPLIT - conversational
{
  let aiFile=null,aiPdfText=null,aiPlan=null,aiMessages=[],aiPageCount=0;
  const uploadArea=document.getElementById('aisplit-upload-area');
  const dropEl=document.getElementById('aisplit-drop'),input=document.getElementById('aisplit-file'),listEl=document.getElementById('aisplit-file-list');
  const chatArea=document.getElementById('aisplit-chat-area'),msgsEl=document.getElementById('aisplit-chat-messages'),chatInput=document.getElementById('aisplit-chat-input');
  const planSection=document.getElementById('aisplit-plan-section'),planList=document.getElementById('aisplit-plan-list');

  function addBubble(text,role){
    const div=document.createElement('div');div.className=`chat-bubble ${role}`;
    // Strip plan tag from displayed text
    div.textContent=(text||'').replace(/<SPLIT_PLAN>[\s\S]*?<\/SPLIT_PLAN>/g,'').trim();
    msgsEl.appendChild(div);msgsEl.scrollTop=msgsEl.scrollHeight;return div;
  }
  function addTyping(){
    const div=document.createElement('div');div.className='chat-bubble ai typing';
    div.innerHTML='<span class="inline-spinner"></span>\u00a0Claude is thinking\u2026';
    msgsEl.appendChild(div);msgsEl.scrollTop=msgsEl.scrollHeight;return div;
  }
  async function loadTesseract(){
    if(window.Tesseract)return window.Tesseract;
    return new Promise((resolve,reject)=>{
      const s=document.createElement('script');
      s.src='https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      s.onload=()=>resolve(window.Tesseract);
      s.onerror=()=>reject(new Error('Failed to load Tesseract.js'));
      document.head.appendChild(s);
    });
  }
  async function ocrPdf(pdf,typingEl){
    const T=await loadTesseract();
    const worker=await T.createWorker('eng');
    let text='';
    for(let i=1;i<=pdf.numPages;i++){
      if(typingEl)typingEl.innerHTML=`<span class="inline-spinner"></span>\u00a0OCR scanning page ${i} of ${pdf.numPages}\u2026`;
      const page=await pdf.getPage(i);
      const viewport=page.getViewport({scale:2});
      const canvas=document.createElement('canvas');
      canvas.width=viewport.width;canvas.height=viewport.height;
      await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
      const result=await worker.recognize(canvas);
      text+=`--- Page ${i} ---\n${result.data.text}\n\n`;
    }
    await worker.terminate();
    return text;
  }
  function renderPlan(plan){
    aiPlan=plan;planList.innerHTML='';
    plan.forEach((item,idx)=>{
      const card=document.createElement('div');card.className='plan-card';
      card.innerHTML=`<div class="plan-card-num">${idx+1}</div><div class="plan-card-body"><input class="plan-card-name" type="text" value="${item.filename.replace(/"/g,'&quot;')}" /><div class="plan-card-pages">Pages\u00a0${item.pages.join(', ')}\u00a0\u00b7\u00a0${item.pages.length}\u00a0page${item.pages.length!==1?'s':''}</div></div>`;
      card.querySelector('.plan-card-name').addEventListener('input',e=>{aiPlan[idx].filename=e.target.value;});
      planList.appendChild(card);
    });
    planSection.style.display='block';
  }
  async function callAI(userMsg){
    const token=await auth.currentUser?.getIdToken(true);
    if(!token){toast('Please sign in again','error');return;}
    if(userMsg){addBubble(userMsg,'user');aiMessages.push({role:'user',content:userMsg});}
    const typing=addTyping();
    chatInput.disabled=true;document.getElementById('aisplit-chat-send').disabled=true;
    try{
      const res=await fetch(`${API}/api/ai-split`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},body:JSON.stringify({pdfText:aiPdfText,messages:aiMessages,filename:aiFile.name,pageCount:aiPageCount})});
      const data=await res.json();
      if(!res.ok)throw new Error(data.error||`Server error ${res.status}`);
      typing.remove();
      const reply=data.reply||'';
      aiMessages.push({role:'assistant',content:reply});
      addBubble(reply,'ai');
      if(data.plan&&Array.isArray(data.plan)&&data.plan.length>0){renderPlan(data.plan);}
    }catch(err){typing.remove();addBubble('Sorry, something went wrong: '+err.message,'ai');toast(err.message,'error');}
    chatInput.disabled=false;document.getElementById('aisplit-chat-send').disabled=false;chatInput.focus();
  }
  async function startConversation(file){
    aiFile=file;aiPlan=null;aiMessages=[];aiPageCount=0;aiPdfText=null;
    planSection.style.display='none';planList.innerHTML='';msgsEl.innerHTML='';
    uploadArea.style.display='none';chatArea.style.display='block';
    const typing=addTyping();
    try{
      const pdfjs=await loadPdfjsLib();const bytes=await file.arrayBuffer();const pdf=await pdfjs.getDocument({data:bytes}).promise;
      aiPageCount=pdf.numPages;let text='';
      for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i);const c=await page.getTextContent();text+=`--- Page ${i} ---\n${c.items.map(it=>it.str).join(' ')}\n\n`;}
      // Detect scanned PDF: if < 30 meaningful chars/page on average, run OCR
      const meaningfulChars=text.replace(/--- Page \d+ ---\n/g,'').replace(/\s+/g,'').length;
      if(meaningfulChars/pdf.numPages<30){
        typing.innerHTML='<span class="inline-spinner"></span>\u00a0Scanned PDF detected \u2014 running OCR on page 1 of '+pdf.numPages+'\u2026';
        try{
          text=await ocrPdf(pdf,typing);
        }catch(ocrErr){
          // OCR failed - tell Claude it\'s a scanned doc so it can still help by page count
          text=`This is a scanned PDF with ${pdf.numPages} pages. Text could not be extracted via OCR (${ocrErr.message}).`;
        }
      }
      aiPdfText=text;
    }catch(err){typing.remove();addBubble('Could not read PDF: '+err.message,'ai');return;}
    typing.remove();
    // Synthetic first turn so Claude opens the conversation
    aiMessages=[{role:'user',content:'I just uploaded my PDF.'}];
    await callAI(null);
  }
  setupDrop(dropEl,input,f=>{
    listEl.innerHTML='';listEl.appendChild(renderFileItem(f[0],()=>{
      aiFile=null;aiPdfText=null;aiPlan=null;aiMessages=[];
      uploadArea.style.display='block';chatArea.style.display='none';planSection.style.display='none';listEl.innerHTML='';
    }));startConversation(f[0]);
  });
  function sendChat(){
    const msg=chatInput.value.trim();if(!msg||!aiFile||chatInput.disabled)return;
    chatInput.value='';planSection.style.display='none';callAI(msg);
  }
  document.getElementById('aisplit-chat-send').addEventListener('click',sendChat);
  chatInput.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat();}});
  document.getElementById('aisplit-apply').addEventListener('click',async()=>{
    if(!aiFile||!aiPlan)return;
    const btn=document.getElementById('aisplit-apply');btn.disabled=true;
    btn.innerHTML='<span class="inline-spinner"></span>Splitting\u2026';
    try{
      const{PDFDocument}=await loadPdfLib();const srcBytes=await aiFile.arrayBuffer();const srcDoc=await PDFDocument.load(srcBytes);
      for(const item of aiPlan){const newDoc=await PDFDocument.create();const idxs=item.pages.map(p=>p-1).filter(i=>i>=0&&i<srcDoc.getPageCount());const pages=await newDoc.copyPages(srcDoc,idxs);pages.forEach(p=>newDoc.addPage(p));const out=await newDoc.save();triggerDownload(new Blob([out],{type:'application/pdf'}),item.filename||`part_${aiPlan.indexOf(item)+1}.pdf`);await new Promise(r=>setTimeout(r,150));}
      Stats.inc(0);toast(`Done \u2014 ${aiPlan.length} files!`);addBubble(`\u2713 Done! ${aiPlan.length} file${aiPlan.length!==1?'s':''} downloaded.`,'ai');
    }catch(err){toast(err.message,'error');addBubble('Error: '+err.message,'ai');}
    btn.disabled=false;btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Apply &amp; Download All';
  });
  document.getElementById('aisplit-revise').addEventListener('click',()=>{planSection.style.display='none';chatInput.focus();});
  document.getElementById('aisplit-clear').addEventListener('click',()=>{
    aiFile=null;aiPdfText=null;aiPlan=null;aiMessages=[];aiPageCount=0;
    listEl.innerHTML='';msgsEl.innerHTML='';uploadArea.style.display='block';chatArea.style.display='none';planSection.style.display='none';input.value='';
  });
}

// EDIT PDF
{
  let editFile=null,editPageOrder=[],pendingTexts=[];
  const dropEl=document.getElementById('edit-drop'),input=document.getElementById('edit-file'),listEl=document.getElementById('edit-file-list'),optsEl=document.getElementById('edit-options'),resultEl=document.getElementById('edit-result');
  async function loadForEdit(file){
    editFile=file;editPageOrder=[];pendingTexts=[];listEl.innerHTML='';
    listEl.appendChild(renderFileItem(file,()=>{editFile=null;editPageOrder=[];pendingTexts=[];optsEl.style.display='none';resultEl.className='result-box';}));
    optsEl.style.display='block';
    const pdfjs=await loadPdfjsLib();const bytes=await file.arrayBuffer();const pdf=await pdfjs.getDocument({data:bytes}).promise;
    editPageOrder=Array.from({length:pdf.numPages},(_,i)=>i+1);
    document.getElementById('edit-page-count').textContent=`(${pdf.numPages} pages)`;
    const pageListEl=document.getElementById('edit-page-list');pageListEl.innerHTML='<div style="font-size:.78rem;color:var(--muted);padding:.5rem">Loading previews\u2026</div>';
    pageListEl.innerHTML='';
    for(const pgNum of editPageOrder){
      const page=await pdf.getPage(pgNum);const vp=page.getViewport({scale:0.18});
      const canvas=document.createElement('canvas');canvas.width=vp.width;canvas.height=vp.height;canvas.className='page-thumb-canvas';
      await page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise;
      const row=document.createElement('div');row.className='page-thumb-row';row.dataset.page=String(pgNum);
      const cb=document.createElement('input');cb.type='checkbox';
      const label=document.createElement('span');label.className='page-thumb-label';label.textContent=`Page ${pgNum}`;
      const btns=document.createElement('div');btns.className='page-thumb-btns';
      const upBtn=document.createElement('button');upBtn.textContent='\u2191';upBtn.title='Move up';
      const dnBtn=document.createElement('button');dnBtn.textContent='\u2193';dnBtn.title='Move down';
      upBtn.addEventListener('click',()=>{const idx=editPageOrder.indexOf(pgNum);if(idx>0){[editPageOrder[idx-1],editPageOrder[idx]]=[editPageOrder[idx],editPageOrder[idx-1]];const prev=row.previousElementSibling;if(prev)pageListEl.insertBefore(row,prev);}});
      dnBtn.addEventListener('click',()=>{const idx=editPageOrder.indexOf(pgNum);if(idx<editPageOrder.length-1){[editPageOrder[idx],editPageOrder[idx+1]]=[editPageOrder[idx+1],editPageOrder[idx]];const next=row.nextElementSibling;if(next)pageListEl.insertBefore(next,row);}});
      cb.addEventListener('change',()=>row.classList.toggle('selected',cb.checked));
      btns.append(upBtn,dnBtn);row.append(cb,canvas,label,btns);pageListEl.appendChild(row);
    }
  }
  setupDrop(dropEl,input,f=>loadForEdit(f[0]));
  document.getElementById('edit-select-all').addEventListener('click',()=>{document.querySelectorAll('#edit-page-list input[type=checkbox]').forEach(cb=>{cb.checked=true;cb.closest('.page-thumb-row').classList.add('selected');});});
  document.getElementById('edit-delete-selected').addEventListener('click',()=>{
    const toRemove=[];document.querySelectorAll('#edit-page-list .page-thumb-row').forEach(row=>{if(row.querySelector('input').checked){toRemove.push(parseInt(row.dataset.page));row.remove();}});
    editPageOrder=editPageOrder.filter(p=>!toRemove.includes(p));document.getElementById('edit-page-count').textContent=`(${editPageOrder.length} pages)`;
    if(toRemove.length)toast(`${toRemove.length} page${toRemove.length!==1?'s':''} removed`);
  });
  document.getElementById('edit-add-text').addEventListener('click',()=>{
    const pageN=parseInt(document.getElementById('edit-text-page').value);const text=document.getElementById('edit-text-content').value.trim();
    if(!text)return toast('Enter text to add','error');
    if(!editPageOrder.includes(pageN))return toast('Invalid page number','error');
    pendingTexts.push({page:pageN,text,x:parseInt(document.getElementById('edit-text-x').value)||50,y:parseInt(document.getElementById('edit-text-y').value)||50,size:parseInt(document.getElementById('edit-text-size').value)||14,color:document.getElementById('edit-text-color').value});
    const qEl=document.getElementById('edit-text-queue');qEl.textContent=`${pendingTexts.length} text overlay${pendingTexts.length!==1?'s':''} queued`;document.getElementById('edit-text-content').value='';toast(`Text queued for page ${pageN}`);
  });
  document.getElementById('edit-save').addEventListener('click',async()=>{
    if(!editFile||!editPageOrder.length)return toast('No pages to save','error');
    const btn=document.getElementById('edit-save');btn.disabled=true;btn.textContent='Saving\u2026';
    try{
      const{PDFDocument,rgb,StandardFonts}=await loadPdfLib();const srcBytes=await editFile.arrayBuffer();const srcDoc=await PDFDocument.load(srcBytes);
      const newDoc=await PDFDocument.create();const font=await newDoc.embedFont(StandardFonts.Helvetica);
      const copiedPages=await newDoc.copyPages(srcDoc,editPageOrder.map(p=>p-1));copiedPages.forEach(p=>newDoc.addPage(p));
      const newPages=newDoc.getPages();
      for(const pt of pendingTexts){const pageIdx=editPageOrder.indexOf(pt.page);if(pageIdx<0)continue;const hex=pt.color.replace('#','');const r=parseInt(hex.slice(0,2),16)/255,g=parseInt(hex.slice(2,4),16)/255,b=parseInt(hex.slice(4,6),16)/255;newPages[pageIdx].drawText(pt.text,{x:pt.x,y:pt.y,size:pt.size,font,color:rgb(r,g,b)});}
      const out=await newDoc.save();triggerDownload(new Blob([out],{type:'application/pdf'}),editFile.name.replace(/\.pdf$/i,'_edited.pdf'));
      Stats.inc(0);showResult(resultEl,'success',`Saved ${newDoc.getPageCount()} pages.`);toast('PDF saved!');
    }catch(err){showResult(resultEl,'error','Error: '+err.message);toast(err.message,'error');}
    btn.disabled=false;btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Save &amp; Download';
  });
  window.__nyxOpenPdf=async function(file){
    if(!file||file.type!=='application/pdf'&&!file.name.toLowerCase().endsWith('.pdf')){toast('NyxPrism can open PDF files only.','error');return;}
    switchPanel('editpdf');
    await loadForEdit(file);
    toast(`Opened ${file.name}`,'success');
  };
  window.__nyxProcessLaunchFiles();
  document.getElementById('edit-clear').addEventListener('click',()=>{editFile=null;editPageOrder=[];pendingTexts=[];listEl.innerHTML='';optsEl.style.display='none';resultEl.className='result-box';document.getElementById('edit-page-list').innerHTML='';document.getElementById('edit-text-queue').textContent='';input.value='';});
}

// CONVERT PDF
{
  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn=>btn.addEventListener('click',()=>{const tab=btn.dataset.tab;document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));document.querySelectorAll('.tab-pane').forEach(p=>p.classList.toggle('active',p.id==='tab-'+tab));}));
  // PDF -> Images
  {
    let p2iFile=null;
    const dropEl=document.getElementById('p2i-drop'),input=document.getElementById('p2i-file'),listEl=document.getElementById('p2i-file-list'),optsEl=document.getElementById('p2i-options'),resultEl=document.getElementById('p2i-result');
    document.getElementById('p2i-scale').addEventListener('input',e=>document.getElementById('p2i-scale-val').textContent=e.target.value+'\u00d7');
    setupDrop(dropEl,input,f=>{p2iFile=f[0];listEl.innerHTML='';listEl.appendChild(renderFileItem(p2iFile,()=>{p2iFile=null;optsEl.style.display='none';resultEl.className='result-box';}));optsEl.style.display='block';});
    document.getElementById('p2i-run').addEventListener('click',async()=>{
      if(!p2iFile)return toast('Select a PDF first','error');
      const btn=document.getElementById('p2i-run');btn.disabled=true;btn.innerHTML='<span class="inline-spinner"></span>Converting\u2026';
      try{
        const pdfjs=await loadPdfjsLib();const bytes=await p2iFile.arrayBuffer();const pdf=await pdfjs.getDocument({data:bytes}).promise;
        const scale=parseFloat(document.getElementById('p2i-scale').value)||2;const fmt=document.getElementById('p2i-format').value;
        const mime=fmt==='jpeg'?'image/jpeg':'image/png';const ext=fmt==='jpeg'?'jpg':'png';const stem=p2iFile.name.replace(/\.pdf$/i,'');
        if(pdf.numPages===1){
          const page=await pdf.getPage(1);const vp=page.getViewport({scale});const canvas=document.createElement('canvas');canvas.width=vp.width;canvas.height=vp.height;await page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise;
          canvas.toBlob(blob=>triggerDownload(blob,`${stem}.${ext}`),mime,0.92);Stats.inc(0);showResult(resultEl,'success',`Converted 1 page to ${ext.toUpperCase()}.`);toast('Done!');
        }else{
          btn.innerHTML='<span class="inline-spinner"></span>Loading JSZip\u2026';
          const JSZip=await new Promise((res,rej)=>{if(window.JSZip)return res(window.JSZip);const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';s.onload=()=>res(window.JSZip);s.onerror=rej;document.head.appendChild(s);});
          const zip=new JSZip();const pad=String(pdf.numPages).length;
          for(let i=1;i<=pdf.numPages;i++){btn.innerHTML=`<span class="inline-spinner"></span>Page ${i}/${pdf.numPages}\u2026`;const page=await pdf.getPage(i);const vp=page.getViewport({scale});const canvas=document.createElement('canvas');canvas.width=vp.width;canvas.height=vp.height;await page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise;const b64=canvas.toDataURL(mime,0.92).split(',')[1];zip.file(`${stem}_page${String(i).padStart(pad,'0')}.${ext}`,b64,{base64:true});}
          const blob=await zip.generateAsync({type:'blob'});triggerDownload(blob,`${stem}_images.zip`);Stats.inc(0);showResult(resultEl,'success',`Converted ${pdf.numPages} pages \u2014 downloading ZIP.`);toast(`${pdf.numPages} pages converted!`);
        }
      }catch(err){showResult(resultEl,'error','Error: '+err.message);toast(err.message,'error');}
      btn.disabled=false;btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Convert to Images';
    });
    document.getElementById('p2i-clear').addEventListener('click',()=>{p2iFile=null;listEl.innerHTML='';optsEl.style.display='none';resultEl.className='result-box';input.value='';});
  }
  // Images -> PDF
  {
    let i2pFiles=[];
    const dropEl=document.getElementById('i2p-drop'),input=document.getElementById('i2p-files'),listEl=document.getElementById('i2p-file-list'),optsEl=document.getElementById('i2p-options'),resultEl=document.getElementById('i2p-result');
    function addImgs(files){files.forEach(f=>{i2pFiles.push(f);listEl.appendChild(renderFileItem(f,()=>{i2pFiles=i2pFiles.filter(x=>x!==f);if(!i2pFiles.length)optsEl.style.display='none';}));});optsEl.style.display=i2pFiles.length?'block':'none';}
    setupDrop(dropEl,input,addImgs);
    document.getElementById('i2p-run').addEventListener('click',async()=>{
      if(!i2pFiles.length)return toast('Add images first','error');
      const btn=document.getElementById('i2p-run');btn.disabled=true;btn.innerHTML='<span class="inline-spinner"></span>Building PDF\u2026';
      try{
        const{PDFDocument}=await loadPdfLib();const pdfDoc=await PDFDocument.create();
        for(const file of i2pFiles){
          const url=URL.createObjectURL(file);const img=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=url;});
          const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;canvas.getContext('2d').drawImage(img,0,0);URL.revokeObjectURL(url);
          const pngBlob=await new Promise(res=>canvas.toBlob(res,'image/png'));const pngBytes=await pngBlob.arrayBuffer();
          const embedded=await pdfDoc.embedPng(pngBytes);const page=pdfDoc.addPage([embedded.width,embedded.height]);page.drawImage(embedded,{x:0,y:0,width:embedded.width,height:embedded.height});
        }
        const out=await pdfDoc.save();const name=document.getElementById('i2p-name').value||'images.pdf';triggerDownload(new Blob([out],{type:'application/pdf'}),name.endsWith('.pdf')?name:name+'.pdf');
        Stats.inc(0);showResult(resultEl,'success',`Built PDF with ${i2pFiles.length} page${i2pFiles.length!==1?'s':''}.`);toast('PDF created!');
      }catch(err){showResult(resultEl,'error','Error: '+err.message);toast(err.message,'error');}
      btn.disabled=false;btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Build PDF';
    });
    document.getElementById('i2p-clear').addEventListener('click',()=>{i2pFiles=[];listEl.innerHTML='';optsEl.style.display='none';resultEl.className='result-box';input.value='';});
  }
    // PDF → Text (extracts text from PDF; auto-OCRs image/scanned PDFs)
  {
    let p2tFile=null;
    const dropEl=document.getElementById('p2t-drop'),input=document.getElementById('p2t-file'),listEl=document.getElementById('p2t-file-list'),optsEl=document.getElementById('p2t-options'),resultEl=document.getElementById('p2t-result'),textArea=document.getElementById('p2t-text');
    setupDrop(dropEl,input,f=>{
      p2tFile=f[0];listEl.innerHTML='';
      listEl.appendChild(renderFileItem(p2tFile,()=>{p2tFile=null;optsEl.style.display='none';resultEl.className='result-box';textArea.value='';document.getElementById('p2t-stats').textContent='';}));
      optsEl.style.display='block';
    });
    document.getElementById('p2t-run').addEventListener('click',async()=>{
      if(!p2tFile)return toast('Select a PDF first','error');
      const btn=document.getElementById('p2t-run');btn.disabled=true;btn.innerHTML='<span class="inline-spinner"></span>Extracting…';
      textArea.value='';document.getElementById('p2t-stats').textContent='';resultEl.className='result-box';
      try{
        const pdfjs=await loadPdfjsLib();const bytes=await p2tFile.arrayBuffer();const pdf=await pdfjs.getDocument({data:bytes}).promise;
        let text='';
        for(let i=1;i<=pdf.numPages;i++){
          btn.innerHTML=`<span class="inline-spinner"></span>Page ${i}/${pdf.numPages}…`;
          const page=await pdf.getPage(i);const c=await page.getTextContent();
          text+=(pdf.numPages>1?`--- Page ${i} ---\n`:'')+c.items.map(it=>it.str).join(' ').trim()+'\n\n';
        }
        const meaningful=text.replace(/--- Page \d+ ---\n/g,'').replace(/\s+/g,'').length;
        if(meaningful/pdf.numPages<30){
          showResult(resultEl,'info','Image PDF detected - running OCR. This may take a moment…');
          btn.innerHTML='<span class="inline-spinner"></span>Loading OCR…';
          const T=await loadTesseract();const worker=await T.createWorker('eng');
          text='';
          for(let i=1;i<=pdf.numPages;i++){
            btn.innerHTML=`<span class="inline-spinner"></span>OCR ${i}/${pdf.numPages}…`;
            const page=await pdf.getPage(i);const vp=page.getViewport({scale:2});
            const canvas=document.createElement('canvas');canvas.width=vp.width;canvas.height=vp.height;
            await page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise;
            const{data:{text:t}}=await worker.recognize(canvas);
            text+=(pdf.numPages>1?`--- Page ${i} ---\n`:'')+t.trim()+'\n\n';
          }
          await worker.terminate();
        }
        textArea.value=text.trim();
        const words=text.trim().split(/\s+/).filter(Boolean).length;
        document.getElementById('p2t-stats').textContent=`${pdf.numPages} page${pdf.numPages!==1?'s':''} · ${words.toLocaleString()} words`;
        showResult(resultEl,'success',`Text extracted from ${pdf.numPages} page${pdf.numPages!==1?'s':''}.`);
        toast('Text extracted!');Stats.inc(0);
      }catch(err){showResult(resultEl,'error','Error: '+err.message);toast(err.message,'error');}
      btn.disabled=false;btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Extract Text';
    });
    document.getElementById('p2t-copy').addEventListener('click',()=>{
      if(!textArea.value)return toast('Nothing to copy','error');
      navigator.clipboard.writeText(textArea.value).then(()=>toast('Copied!')).catch(()=>toast('Copy failed','error'));
    });
    document.getElementById('p2t-dl').addEventListener('click',()=>{
      if(!textArea.value||!p2tFile)return toast('Extract text first','error');
      triggerDownload(new Blob([textArea.value],{type:'text/plain;charset=utf-8'}),p2tFile.name.replace(/\.pdf$/i,'.txt'));
    });
    document.getElementById('p2t-clear').addEventListener('click',()=>{
      p2tFile=null;listEl.innerHTML='';optsEl.style.display='none';resultEl.className='result-box';
      textArea.value='';document.getElementById('p2t-stats').textContent='';input.value='';
    });
  }
  // PDF -> Searchable PDF (invisible OCR text layer)
  {
    let p2sFile=null;
    var p2sDrop=document.getElementById('p2s-drop');
    var p2sInput=document.getElementById('p2s-file');
    var p2sList=document.getElementById('p2s-file-list');
    var p2sOpts=document.getElementById('p2s-options');
    var p2sRes=document.getElementById('p2s-result');
    var p2sWrap=document.getElementById('p2s-progress'),p2sBar=document.getElementById('p2s-bar'),p2sStat=document.getElementById('p2s-status');
    setupDrop(p2sDrop,p2sInput,function(f){
      p2sFile=f[0];p2sList.innerHTML='';
      p2sList.appendChild(renderFileItem(p2sFile,function(){p2sFile=null;p2sOpts.style.display='none';p2sRes.className='result-box';}));
      p2sOpts.style.display='block';
    });
    p2sInput&&p2sInput.addEventListener('change',function(){
      if(this.files[0]){p2sFile=this.files[0];p2sList.innerHTML='';p2sList.appendChild(renderFileItem(p2sFile,function(){p2sFile=null;p2sOpts.style.display='none';p2sRes.className='result-box';}));p2sOpts.style.display='block';}
    });
    document.getElementById('p2s-clear')&&document.getElementById('p2s-clear').addEventListener('click',function(){p2sFile=null;p2sInput.value='';p2sList.innerHTML='';p2sOpts.style.display='none';p2sRes.className='result-box';});
    document.getElementById('p2s-run')&&document.getElementById('p2s-run').addEventListener('click',async function(){
      if(!p2sFile)return toast('Select a PDF first','error');
      var btn=document.getElementById('p2s-run');
      btn.disabled=true;btn.innerHTML='<span class="inline-spinner"></span> Processing...';
      var lang=document.getElementById('p2s-lang').value;
      showResult(p2sRes,'info','Loading PDF...');p2sRes.style.display='block';
      try{
        var pdfLibMod=await loadPdfLib();
        var PDFDocument=pdfLibMod.PDFDocument,rgb=pdfLibMod.rgb,StandardFonts=pdfLibMod.StandardFonts;
        var pdfjsLib=await loadPdfjsLib();
        var T=await loadTesseract();
        var ab=await p2sFile.arrayBuffer();
        var pdfDoc=await PDFDocument.load(ab.slice(0));
        var pdfjsDoc=await pdfjsLib.getDocument({data:ab}).promise;
        var numPages=pdfjsDoc.numPages;
        var font=await pdfDoc.embedFont(StandardFonts.Helvetica);
        var pdfPages=pdfDoc.getPages();
        var worker=await T.createWorker(lang);
        for(var i=1;i<=numPages;i++){
          btn.innerHTML='<span class="inline-spinner"></span> OCR '+i+'/'+numPages+'...';
          showResult(p2sRes,'info','OCR page '+i+' of '+numPages+'...');
          p2sWrap.style.display='block';p2sBar.style.width=Math.round(i/numPages*100)+'%';p2sStat.textContent='Page '+i+' of '+numPages;
          var page=await pdfjsDoc.getPage(i);
          var vp=page.getViewport({scale:2.0});
          var canvas=document.createElement('canvas');canvas.width=vp.width;canvas.height=vp.height;
          await page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise;
          var ocr=await worker.recognize(canvas);
          var data=ocr.data;
          var pdfPage=pdfPages[i-1];
          var sz=pdfPage.getSize();var pdfW=sz.width,pdfH=sz.height;
          var scaleX=pdfW/vp.width,scaleY=pdfH/vp.height;
          var words=data.words||[];
          for(var wi=0;wi<words.length;wi++){
            var word=words[wi];
            if(!word.text.trim()||word.confidence<30)continue;
            var wx=word.bbox.x0*scaleX;
            var wordH=(word.bbox.y1-word.bbox.y0)*scaleY;
            var wy=pdfH-word.bbox.y1*scaleY;
            var fontSize=Math.max(1,wordH*0.9);
            try{pdfPage.drawText(word.text,{x:wx,y:wy,size:fontSize,font:font,color:rgb(1,1,1),opacity:0.01});}catch(e2){}
          }
        }
        await worker.terminate();
        var out=await pdfDoc.save();
        var outName=p2sFile.name.replace(/\.pdf$/i,'')+'-searchable.pdf';
        triggerDownload(new Blob([out],{type:'application/pdf'}),outName);
        Stats.inc(p2sFile.size/1048576);
        showResult(p2sRes,'success','Searchable PDF created from '+numPages+' page'+(numPages!==1?'s':'')+'! Download started.');
        p2sStat.textContent='Done!';
        toast('Searchable PDF ready!');
      }catch(err){p2sBar.style.width='0%';showResult(p2sRes,'error','Error: '+err.message);toast(err.message,'error');}
      finally{setTimeout(()=>{p2sWrap.style.display='none';p2sBar.style.width='0%';},1500);}
      btn.disabled=false;btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Make Searchable PDF';
    });
  }
}

// ═══════════════════════════════════════════════════════
// PDF + QR CODE STAMP
{
  let p2qFile = null;
  const p2qDrop = document.getElementById('p2q-drop');
  const p2qInput = document.getElementById('p2q-file');
  const p2qList = document.getElementById('p2q-file-list');
  const p2qOpts = document.getElementById('p2q-options');
  const p2qRes = document.getElementById('p2q-result');
  function p2qSetFile(file) {
    p2qFile = file;
    p2qList.innerHTML = '';
    p2qList.appendChild(renderFileItem(file, () => { p2qFile = null; p2qOpts.style.display = 'none'; p2qRes.className = 'result-box'; }));
    p2qOpts.style.display = 'block';
  }
  if(p2qDrop) setupDrop(p2qDrop, p2qInput, fs => { if(fs[0]) p2qSetFile(fs[0]); });
  document.getElementById('p2q-clear') && document.getElementById('p2q-clear').addEventListener('click', () => {
    p2qFile = null; p2qList.innerHTML = ''; p2qOpts.style.display = 'none'; p2qRes.className = 'result-box';
    document.getElementById('p2q-text').value = '';
  });
  document.getElementById('p2q-run') && document.getElementById('p2q-run').addEventListener('click', async () => {
    if(!p2qFile) return toast('Select a PDF first', 'error');
    const qrText = (document.getElementById('p2q-text').value || '').trim();
    if(!qrText) return toast('Enter a URL or text to encode in the QR', 'error');
    const btn = document.getElementById('p2q-run');
    btn.disabled = true; btn.innerHTML = '<span class="inline-spinner"></span> Stamping...';
    showResult(p2qRes, 'info', 'Generating QR code...'); p2qRes.style.display = 'block';
    try {
      const QRCode = await loadQRCode();
      const size = parseInt(document.getElementById('p2q-size').value) || 80;
      const margin = parseInt(document.getElementById('p2q-margin').value) || 16;
      const pos = document.getElementById('p2q-position').value;
      const pages = document.getElementById('p2q-pages').value;
      // Generate QR as data URL via canvas
      const qrDataUrl = await QRCode.toDataURL(qrText, { width: 256, margin: 1, errorCorrectionLevel: 'M' });
      // Fetch as Uint8Array for pdf-lib
      const qrResp = await fetch(qrDataUrl);
      const qrBytes = new Uint8Array(await qrResp.arrayBuffer());
      showResult(p2qRes, 'info', 'Embedding QR into PDF...');
      const { PDFDocument } = await loadPdfLib();
      const srcBytes = await p2qFile.arrayBuffer();
      const pdfDoc = await PDFDocument.load(srcBytes);
      const qrImage = await pdfDoc.embedPng(qrBytes);
      const pdfPages = pdfDoc.getPages();
      const total = pdfPages.length;
      let indices = [];
      if(pages === 'first') indices = [0];
      else if(pages === 'last') indices = [total - 1];
      else indices = Array.from({length: total}, (_, i) => i);
      indices.forEach(idx => {
        const pg = pdfPages[idx];
        const { width, height } = pg.getSize();
        let x, y;
        if(pos === 'br')      { x = width  - size - margin; y = margin; }
        else if(pos === 'bl') { x = margin;                 y = margin; }
        else if(pos === 'tr') { x = width  - size - margin; y = height - size - margin; }
        else                  { x = margin;                 y = height - size - margin; } // tl
        pg.drawImage(qrImage, { x, y, width: size, height: size });
      });
      const out = await pdfDoc.save();
      const outName = p2qFile.name.replace(/\.pdf$/i, '') + '-qr.pdf';
      triggerDownload(new Blob([out], { type: 'application/pdf' }), outName);
      Stats.inc(p2qFile.size / 1048576);
      showResult(p2qRes, 'success', 'QR code stamped on ' + indices.length + ' page' + (indices.length !== 1 ? 's' : '') + '! Download started.');
    } catch(err) { showResult(p2qRes, 'error', 'Error: ' + err.message); }
    finally { btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>Add QR Code'; }
  });
  // Tab switching for convert panel
  document.querySelectorAll('#panel-convert .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#panel-convert .tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('#panel-convert .tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const pane = document.getElementById('tab-' + btn.dataset.tab);
      if(pane) pane.classList.add('active');
    });
  });
}

// AI ASSIST - embedded chat helper on every tool panel
{
  const _aiSessions={};
  const _SEND_ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
  const _SPARK_ICON='<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></svg>';

  const _AI_PANELS=[
    {p:'split',      tip:'Ask: "My PDF has 80 pages - help me split it by chapter" or "split every 5 pages"'},
    {p:'merge',      tip:'Ask: "I have 3 reports, what order should I merge them?" or "combine alphabetically"'},
    {p:'compress',   tip:'Ask: "What quality should I pick for emailing this PDF?" or "make it under 1 MB"'},
    {p:'watermark',  tip:'Ask: "What text should I watermark on a draft contract?" or "where to place it"'},
    {p:'protect',    tip:'Ask: "Is my password strong enough?" or "what level of encryption do I need?"'},
    {p:'extract',    tip:'Ask: "How do I extract just the appendix?" or "pull out pages 10-20"'},
    {p:'ocr',        tip:'Ask: "My scan is blurry, will OCR work?" or "which language should I pick?"'},
    {p:'rotate',     tip:'Ask: "Some pages are sideways, what angle?" or "which pages need rotating?"'},
    {p:'editpdf',    tip:'Ask: "I need to remove blank pages" or "how do I reorder pages?"'},
    {p:'convert',    tip:'Ask: "PNG or JPEG for my presentation?" or "how do I get editable text from a scan?"'},
    {p:'sign',       tip:'Ask: "Where should I place my signature?" or "what size looks professional?"'},
    {p:'annotate',   tip:'Ask: "What annotations are useful for a legal review?" or "how to mark corrections"'},
    {p:'pagemanager',tip:'Ask: "How do I fix my page order?" or "remove the cover and back page"'},
    {p:'number',     tip:'Ask: "Should I skip page 1?" or "what format for a report: 1/20 or just 1?"'},
    {p:'redact',     tip:'Ask: "What sensitive info should I black out?" or "how do I verify nothing slipped through?"'},
    {p:'batch',      tip:'Ask: "Best quality for 50 scanned pages?" or "will this preserve my PDF bookmarks?"'},
  ];

  _AI_PANELS.forEach(({p,tip})=>{
    const panelEl=document.getElementById('panel-'+p);
    if(!panelEl)return;
    const strip=document.createElement('div');
    strip.className='ai-assist-strip';
    strip.innerHTML=
      `<button class="ai-assist-toggle" data-ai-tool="${p}">${_SPARK_ICON}\u00a0Ask AI</button>`+
      `<div class="ai-assist-area" id="ai-area-${p}" style="display:none">`+
        `<div class="chat-messages" id="ai-msgs-${p}"><div style="font-size:.77rem;color:var(--muted);padding:.05rem 0">${tip}</div></div>`+
        `<div class="chat-input-row">`+
          `<input class="chat-input" id="ai-input-${p}" placeholder="Ask anything\u2026" autocomplete="off"/>`+
          `<button class="btn btn-primary chat-send-btn" id="ai-send-${p}">${_SEND_ICON}</button>`+
        `</div>`+
      `</div>`;
    panelEl.appendChild(strip);
  });

  async function _runAiAssist(toolName){
    const msgsEl=document.getElementById('ai-msgs-'+toolName);
    const inputEl=document.getElementById('ai-input-'+toolName);
    const sendEl=document.getElementById('ai-send-'+toolName);
    if(!msgsEl||!inputEl)return;
    const msg=inputEl.value.trim();if(!msg||sendEl.disabled)return;
    inputEl.value='';
    if(!_aiSessions[toolName])_aiSessions[toolName]=[];
    const userDiv=document.createElement('div');userDiv.className='chat-bubble user';userDiv.textContent=msg;
    msgsEl.appendChild(userDiv);msgsEl.scrollTop=msgsEl.scrollHeight;
    _aiSessions[toolName].push({role:'user',content:msg});
    const typing=document.createElement('div');typing.className='chat-bubble ai typing';
    typing.innerHTML='<span class="inline-spinner"></span>\u00a0Claude is thinking\u2026';
    msgsEl.appendChild(typing);msgsEl.scrollTop=msgsEl.scrollHeight;
    sendEl.disabled=true;inputEl.disabled=true;
    try{
      const token=await auth.currentUser?.getIdToken(true);
      if(!token)throw new Error('Please sign in again');
      const res=await fetch(`${API}/api/ai-assist`,{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
        body:JSON.stringify({tool:toolName,messages:_aiSessions[toolName]})
      });
      const data=await res.json();
      if(!res.ok)throw new Error(data.error||`Error ${res.status}`);
      typing.remove();
      const reply=data.reply||'';
      _aiSessions[toolName].push({role:'assistant',content:reply});
      const aiDiv=document.createElement('div');aiDiv.className='chat-bubble ai';aiDiv.textContent=reply;
      msgsEl.appendChild(aiDiv);msgsEl.scrollTop=msgsEl.scrollHeight;
    }catch(err){
      typing.remove();
      const errDiv=document.createElement('div');errDiv.className='chat-bubble ai';errDiv.textContent='Sorry: '+err.message;
      msgsEl.appendChild(errDiv);toast(err.message,'error');
    }
    sendEl.disabled=false;inputEl.disabled=false;inputEl.focus();
  }

  document.querySelectorAll('.ai-assist-toggle').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const tool=btn.dataset.aiTool;
      const area=document.getElementById('ai-area-'+tool);
      if(!area)return;
      const open=area.style.display!=='none';
      area.style.display=open?'none':'block';
      if(!open){const inp=document.getElementById('ai-input-'+tool);if(inp)inp.focus();}
    });
  });

  _AI_PANELS.forEach(({p})=>{
    const s=document.getElementById('ai-send-'+p);
    const i=document.getElementById('ai-input-'+p);
    if(s)s.addEventListener('click',()=>_runAiAssist(p));
    if(i)i.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();_runAiAssist(p);}});
  });
}

// ═══════════════════════════════════════════════════════
// SIGN PDF
{
  let signMode = 'draw';
  let signIsDrawing = false;
  let signLastX = 0, signLastY = 0;
  const signCanvas = document.getElementById('sign-canvas');
  const signCtx = signCanvas ? signCanvas.getContext('2d') : null;
  if (signCtx) {
    signCtx.strokeStyle = '#1a1a2e';
    signCtx.lineWidth = 2;
    signCtx.lineCap = 'round';
    signCtx.lineJoin = 'round';
    function getSignPos(e) {
      const r = signCanvas.getBoundingClientRect();
      const src = e.touches ? e.touches[0] : e;
      return [(src.clientX - r.left) * (signCanvas.width / r.width), (src.clientY - r.top) * (signCanvas.height / r.height)];
    }
    signCanvas.addEventListener('mousedown', e => { signIsDrawing = true; [signLastX, signLastY] = getSignPos(e); });
    signCanvas.addEventListener('touchstart', e => { e.preventDefault(); signIsDrawing = true; [signLastX, signLastY] = getSignPos(e); }, {passive:false});
    signCanvas.addEventListener('mousemove', e => { if (!signIsDrawing) return; const [x,y] = getSignPos(e); signCtx.beginPath(); signCtx.moveTo(signLastX, signLastY); signCtx.lineTo(x,y); signCtx.stroke(); [signLastX, signLastY] = [x,y]; });
    signCanvas.addEventListener('touchmove', e => { e.preventDefault(); if (!signIsDrawing) return; const [x,y] = getSignPos(e); signCtx.beginPath(); signCtx.moveTo(signLastX, signLastY); signCtx.lineTo(x,y); signCtx.stroke(); [signLastX, signLastY] = [x,y]; }, {passive:false});
    signCanvas.addEventListener('mouseup', () => { signIsDrawing = false; });
    signCanvas.addEventListener('touchend', () => { signIsDrawing = false; });
    document.getElementById('sign-clear-draw').addEventListener('click', () => signCtx.clearRect(0, 0, signCanvas.width, signCanvas.height));
  }
  document.querySelectorAll('#panel-sign .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#panel-sign .tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('#panel-sign .tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      signMode = btn.dataset.tab.replace('sign-', '');
    });
  });
  document.getElementById('sign-size') && document.getElementById('sign-size').addEventListener('input', e => document.getElementById('sign-size-val').textContent = e.target.value + 'px');
  document.getElementById('sign-opacity') && document.getElementById('sign-opacity').addEventListener('input', e => document.getElementById('sign-opacity-val').textContent = e.target.value + '%');
  setupDrop(document.getElementById('sign-drop'), document.getElementById('sign-file'), () => {});
  const signImgDrop = document.getElementById('sign-img-drop');
  const signImgFile = document.getElementById('sign-img-file');
  const signImgPrev = document.getElementById('sign-img-preview');
  if (signImgDrop) {
    signImgDrop.addEventListener('click', () => signImgFile.click());
    signImgDrop.addEventListener('dragover', e => { e.preventDefault(); signImgDrop.classList.add('drag-over'); });
    signImgDrop.addEventListener('dragleave', () => signImgDrop.classList.remove('drag-over'));
    signImgDrop.addEventListener('drop', e => { e.preventDefault(); signImgDrop.classList.remove('drag-over'); if (e.dataTransfer.files[0]) { signImgFile.files = e.dataTransfer.files; showSignImgPreview(e.dataTransfer.files[0]); } });
    signImgFile.addEventListener('change', () => { if (signImgFile.files[0]) showSignImgPreview(signImgFile.files[0]); });
    function showSignImgPreview(f) { const r = new FileReader(); r.onload = ev => { signImgPrev.src = ev.target.result; signImgPrev.style.display = 'block'; }; r.readAsDataURL(f); }
  }
  document.getElementById('sign-apply-btn') && document.getElementById('sign-apply-btn').addEventListener('click', async () => {
    const file = document.getElementById('sign-file').files[0];
    if (!file) return toast('Please upload a PDF first', 'error');
    const resultEl = document.getElementById('sign-result');
    const btn = document.getElementById('sign-apply-btn');
    let sigDataUrl = null;
    if (signMode === 'draw') {
      const blank = document.createElement('canvas'); blank.width = signCanvas.width; blank.height = signCanvas.height;
      if (signCanvas.toDataURL() === blank.toDataURL()) return toast('Please draw your signature first', 'error');
      sigDataUrl = signCanvas.toDataURL('image/png');
    } else if (signMode === 'type') {
      const txt = document.getElementById('sign-type-text').value.trim();
      if (!txt) return toast('Please type your signature', 'error');
      const tc = document.getElementById('sign-type-canvas');
      tc.width = 500; tc.height = 100;
      const tctx = tc.getContext('2d');
      tctx.clearRect(0,0,tc.width,tc.height);
      tctx.font = '52px cursive';
      tctx.fillStyle = '#1a1a2e';
      tctx.textBaseline = 'middle';
      tctx.fillText(txt, 10, tc.height / 2);
      sigDataUrl = tc.toDataURL('image/png');
    } else {
      if (!signImgPrev || !signImgPrev.src || signImgPrev.style.display === 'none') return toast('Please upload a signature image', 'error');
      sigDataUrl = signImgPrev.src;
    }
    btn.innerHTML = '<span class="inline-spinner"></span> Signing...';
    btn.disabled = true;
    showResult(resultEl, 'info', 'Embedding signature...');
    resultEl.style.display = 'block';
    try {
      const { PDFDocument } = await loadPdfLib();
      const pdfBytes = await file.arrayBuffer();
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const pages = pdfDoc.getPages();
      const sigW = parseInt(document.getElementById('sign-size').value);
      const opacity = parseInt(document.getElementById('sign-opacity').value) / 100;
      const pos = document.getElementById('sign-position').value;
      const pageTarget = document.getElementById('sign-page').value;
      const resp = await fetch(sigDataUrl);
      const imgBytes = await resp.arrayBuffer();
      const sigImg = await pdfDoc.embedPng(imgBytes);
      const aspect = sigImg.width / sigImg.height;
      const sigH = sigW / aspect;
      const targetPages = pageTarget === 'first' ? [pages[0]] : pageTarget === 'last' ? [pages[pages.length - 1]] : pages;
      for (const pg of targetPages) {
        const { width, height } = pg.getSize();
        const margin = 20;
        let x, y;
        if (pos === 'br') { x = width - sigW - margin; y = margin; }
        else if (pos === 'bl') { x = margin; y = margin; }
        else if (pos === 'bc') { x = (width - sigW) / 2; y = margin; }
        else { x = width - sigW - margin; y = height - sigH - margin; }
        pg.drawImage(sigImg, { x, y, width: sigW, height: sigH, opacity });
      }
      const out = await pdfDoc.save();
      triggerDownload(new Blob([out], { type: 'application/pdf' }), file.name.replace(/.pdf$/i, '') + '-signed.pdf');
      Stats.inc(file.size / 1048576);
      showResult(resultEl, 'success', 'Signature applied! Download started.');
    } catch(err) {
      showResult(resultEl, 'error', 'Error: ' + err.message);
    } finally {
      btn.innerHTML = 'Apply Signature'; btn.disabled = false;
    }
  });
}

// ═══════════════════════════════════════════════════════
// REQUEST SIGNATURES
async function loadSavedPeople(select){
  const token=await auth.currentUser?.getIdToken(true);if(!token)return;
  try{
    const res=await fetch(API+'/api/saved-contacts',{headers:{Authorization:'Bearer '+token}});const data=await res.json();if(!res.ok)throw new Error(data.error||'Could not load saved people');
    select.replaceChildren();const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent=data.contacts.length?'Select a saved person':'No saved people yet';select.appendChild(placeholder);
    data.contacts.forEach(contact=>{const option=document.createElement('option');option.value=String(contact.id);option.textContent=contact.name+' - '+contact.email;option.dataset.name=contact.name;option.dataset.email=contact.email;select.appendChild(option);});
  }catch(err){select.replaceChildren();const option=document.createElement('option');option.value='';option.textContent='Saved people unavailable';select.appendChild(option);}
}
// Single-step tools get a 1 · 2 · 3 progress strip that follows what the user has done:
// a file is chosen when the file list fills or a hidden options area appears, and the
// last step completes when the tool shows a success result. Tool code is untouched.
const TOOL_STEPS={
  split:'Get your files',merge:'Get your file',compress:'Get your file',watermark:'Get your file',protect:'Get your file',
  extract:'Get your text',ocr:'Get your text',rotate:'Get your file',editpdf:'Get your file',annotate:'Get your file',
  pagemanager:'Get your file',number:'Get your file',redact:'Get your file',batch:'Get your files',meta:'Save changes',
  headerfooter:'Get your file',flatten:'Get your file',
};
function initToolSteps(){
  Object.entries(TOOL_STEPS).forEach(([id,finalLabel])=>{
    const panel=document.getElementById('panel-'+id);if(!panel||panel.querySelector('.tool-steps'))return;
    const header=panel.querySelector('.page-header');const drop=panel.querySelector('.drop-zone');if(!header||!drop)return;
    const merge=id==='merge'||id==='batch';
    const strip=document.createElement('ol');strip.className='wizard-steps tool-steps';strip.setAttribute('aria-label','Progress');
    [[1,merge?'Choose files':'Choose a file'],[2,'Set options'],[3,finalLabel]].forEach(([n,label])=>{
      const li=document.createElement('li');li.dataset.step=n;
      const num=document.createElement('span');num.className='num';num.textContent=n;
      const text=document.createElement('span');text.textContent=label;li.append(num,text);strip.appendChild(li);
    });
    header.after(strip);
    // Areas the tool reveals once a file is loaded (hidden in the page as delivered).
    const revealed=[...panel.querySelectorAll('[style*="display:none"],[style*="display: none"]')].filter(el=>!el.classList.contains('result-box')&&!el.closest('.result-box')&&el.id);
    const fileList=panel.querySelector('.file-list');
    const visible=el=>el.style.display!=='none'&&getComputedStyle(el).display!=='none';
    function update(){
      const picked=[...panel.querySelectorAll('input[type=file]')].some(i=>i.files&&i.files.length);
      const hasFile=picked||(fileList&&fileList.children.length>0)||revealed.some(visible);
      const done=[...panel.querySelectorAll('.result-box.success')].some(r=>r.classList.contains('visible')&&visible(r));
      const step=done?4:hasFile?2:1;
      strip.querySelectorAll('li').forEach(li=>{const n=Number(li.dataset.step);li.classList.toggle('active',n===Math.min(step,3)&&!done);li.classList.toggle('done',n<step);li.classList.toggle('jump',n===1&&step>1);});
    }
    strip.querySelector('li[data-step="1"]').addEventListener('click',()=>drop.scrollIntoView({behavior:'smooth',block:'center'}));
    panel.addEventListener('change',()=>requestAnimationFrame(update),true);
    panel.addEventListener('drop',()=>requestAnimationFrame(update),true);
    let queued=false;
    new MutationObserver(()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;update();});}).observe(panel,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class']});
    update();
  });
}
initToolSteps();

// Step-by-step workflow: validate(step) returns an error string or '', onEnter(step) runs on arrival.
function createWizard(root,{validate=()=>'',onEnter=()=>{}}={}){
  const tabs=[...root.querySelectorAll('.wizard-steps li')],panes=[...root.querySelectorAll('.wizard-pane')];
  let current=1,furthest=1;
  function show(step){
    current=step;furthest=Math.max(furthest,step);
    tabs.forEach(li=>{const n=Number(li.dataset.step);li.classList.toggle('active',n===step);li.classList.toggle('done',n<step||(n<=furthest&&n!==step));});
    panes.forEach(p=>p.classList.toggle('active',Number(p.dataset.step)===step));
    root.querySelectorAll('[data-error]').forEach(e=>{e.textContent='';e.classList.remove('show');});
    onEnter(step);
    root.scrollIntoView({behavior:'smooth',block:'start'});
  }
  function next(){
    const pane=panes.find(p=>Number(p.dataset.step)===current);const err=validate(current);
    if(err){const box=pane.querySelector('[data-error]');if(box){box.textContent=err;box.classList.add('show');}return false;}
    show(current+1);return true;
  }
  const clearErrors=()=>root.querySelectorAll('[data-error].show').forEach(e=>{e.textContent='';e.classList.remove('show');});
  root.addEventListener('input',clearErrors);root.addEventListener('change',clearErrors);
  root.querySelectorAll('.wizard-pane').forEach(p=>p.addEventListener('click',e=>{if(!e.target.closest('[data-next]'))clearErrors();}));
  root.querySelectorAll('[data-next]').forEach(b=>b.addEventListener('click',next));
  root.querySelectorAll('[data-back]').forEach(b=>b.addEventListener('click',()=>show(current-1)));
  tabs.forEach(li=>li.addEventListener('click',()=>{const n=Number(li.dataset.step);if(n<current)show(n);else if(n<=furthest){for(let i=current;i<n;i++){if(!next())return;}}}));
  return {show,reset(){furthest=1;show(1);},get step(){return current;}};
}
function useSavedPerson(select,addRecipient){const option=select.selectedOptions[0];if(!option?.value)return toast('Choose a saved person first','error');addRecipient(option.dataset.name,option.dataset.email);select.value='';}
(function(){
  const fileInput=document.getElementById('sigreq-file'),drop=document.getElementById('sigreq-drop'),canvas=document.getElementById('sigreq-canvas'),stage=document.getElementById('sigreq-stage');
  if(!fileInput||!drop||!canvas||!stage)return;
  const ctx=canvas.getContext('2d');
  const recipientsEl=document.getElementById('sigreq-recipients'),resultEl=document.getElementById('sigreq-result');
  let sigreqFile=null,sigreqPdf=null,sigreqPage=1,sigreqFields=[];
  function recipients(){return Array.from(recipientsEl.querySelectorAll('.sigreq-recipient')).map(row=>({name:row.querySelector('.sr-name').value.trim(),email:row.querySelector('.sr-email').value.trim()})).filter(r=>r.name||r.email);}
  // The picked row wins only if it has an email; otherwise fall back to the first signer that does,
  // so an empty row left at the top never blocks placing fields.
  function selectedRecipient(){const rows=Array.from(recipientsEl.querySelectorAll('.sigreq-recipient')).filter(r=>r.querySelector('.sr-email').value.trim());const checked=rows.find(r=>r.querySelector('.sr-pick').checked)||rows[0];return checked?checked.querySelector('.sr-email').value.trim().toLowerCase():'';}
  function addRecipient(name='',email=''){
    if(name||email){const empty=Array.from(recipientsEl.querySelectorAll('.sigreq-recipient')).find(r=>!r.querySelector('.sr-name').value.trim()&&!r.querySelector('.sr-email').value.trim());
      if(empty){empty.querySelector('.sr-name').value=name;empty.querySelector('.sr-email').value=email;renderFields();return;}}
    const row=document.createElement('div');row.className='sigreq-recipient recipient-row signature-recipient';
    const pick=document.createElement('input');pick.className='sr-pick recipient-pick';pick.type='radio';pick.name='sigreq-recipient-pick';pick.checked=!recipientsEl.children.length;pick.setAttribute('aria-label','Assign fields to this recipient');
    const nameInput=document.createElement('input');nameInput.className='form-input sr-name';nameInput.placeholder='Name';nameInput.value=name;
    const emailInput=document.createElement('input');emailInput.className='form-input sr-email';emailInput.type='email';emailInput.placeholder='email@example.com';emailInput.value=email;
    const remove=document.createElement('button');remove.className='recipient-remove';remove.type='button';remove.title='Remove recipient';remove.setAttribute('aria-label','Remove recipient');remove.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    remove.addEventListener('click',()=>{row.remove();if(!recipientsEl.querySelector('.sr-pick:checked')&&recipientsEl.querySelector('.sr-pick'))recipientsEl.querySelector('.sr-pick').checked=true;renderFields();});
    emailInput.addEventListener('input',renderFields);pick.addEventListener('change',renderChips);
    const order=document.createElement('span');order.className='signer-order';order.setAttribute('aria-hidden','true');
    row.append(order,pick,nameInput,emailInput,remove);
    recipientsEl.appendChild(row);
  }
  addRecipient();
  document.getElementById('sigreq-add-recipient').addEventListener('click',()=>addRecipient());
  const savedPeopleSelect=document.getElementById('sigreq-saved-person');
  document.getElementById('sigreq-use-saved').addEventListener('click',()=>useSavedPerson(savedPeopleSelect,addRecipient));
  async function renderPage(){
    if(!sigreqPdf)return;
    const page=await sigreqPdf.getPage(sigreqPage);const vp=page.getViewport({scale:1.15});canvas.width=vp.width;canvas.height=vp.height;
    await page.render({canvasContext:ctx,viewport:vp}).promise;
    document.getElementById('sigreq-page-info').textContent='Page '+sigreqPage+' / '+sigreqPdf.numPages;
    renderFields();
  }
  function renderFields(){
    stage.querySelectorAll('.sigreq-box').forEach(el=>el.remove());
    sigreqFields.filter(f=>f.pageNumber===sigreqPage).forEach((field,idx)=>{
      const el=document.createElement('div');el.className='sigreq-box';el.style.left=(field.x*canvas.offsetWidth)+'px';el.style.top=(field.y*canvas.offsetHeight)+'px';el.style.width=(field.width*canvas.offsetWidth)+'px';el.style.height=(field.height*canvas.offsetHeight)+'px';
      const color=signerColor(field.assignedTo);el.style.borderColor=color;el.style.background=color+'22';
      el.textContent=field.label+' · '+(signerName(field.assignedTo)||'signer');
      const x=document.createElement('button');x.className='x';x.type='button';x.textContent='×';x.addEventListener('click',e=>{e.stopPropagation();sigreqFields=sigreqFields.filter(f=>f!==field);renderFields();renderChips();});el.appendChild(x);
      let dragging=false,dx=0,dy=0;el.addEventListener('pointerdown',e=>{if(e.target===x)return;dragging=true;dx=e.offsetX;dy=e.offsetY;el.setPointerCapture(e.pointerId);});
      el.addEventListener('pointermove',e=>{if(!dragging)return;const r=stage.getBoundingClientRect();field.x=Math.max(0,Math.min(.98,(e.clientX-r.left-dx)/canvas.offsetWidth));field.y=Math.max(0,Math.min(.98,(e.clientY-r.top-dy)/canvas.offsetHeight));el.style.left=(field.x*canvas.offsetWidth)+'px';el.style.top=(field.y*canvas.offsetHeight)+'px';});
      el.addEventListener('pointerup',()=>dragging=false);stage.appendChild(el);
    });
  }
  function addField(type,x=.12,y=.12){
    const assignedTo=selectedRecipient();if(!assignedTo){toast('Add and select a recipient first','error');return;}
    // Stagger new fields so several added in a row don't stack exactly on top of each other.
    const onPage=sigreqFields.filter(f=>f.pageNumber===sigreqPage).length;
    if(x===.12&&y===.12){x=Math.min(.7,.12+(onPage%5)*.05);y=Math.min(.85,.12+(onPage%8)*.08);}
    sigreqFields.push({type,assignedTo,pageNumber:sigreqPage,x,y,width:type==='checkbox'?.06:.24,height:.065,label:type.charAt(0).toUpperCase()+type.slice(1),required:true});renderFields();renderChips();
  }
  function fileToDataUrl(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});}
  async function loadRequests(){
    const list=document.getElementById('sigreq-list');const token=await auth.currentUser?.getIdToken(true);if(!token)return;
    try{const res=await fetch(API+'/api/sign-requests',{headers:{Authorization:'Bearer '+token}});const data=await res.json();if(!res.ok)throw new Error(data.error||'Load failed');
      if(!data.requests.length){list.innerHTML='<div style="color:var(--muted);font-size:.85rem">No signature requests yet.</div>';return;}
      list.innerHTML='';data.requests.forEach(req=>{const row=document.createElement('div');row.className='recent-file-row';const canVoid=['draft','sent','in_progress'].includes(req.status);const canRemind=['sent','in_progress'].includes(req.status);row.innerHTML='<span class="recent-fname">'+escapeHtml(req.title)+'</span><span class="recent-tool-badge">'+escapeHtml(req.status)+'</span>'+(req.status!=='draft'?'<button class="btn btn-ghost activity" style="font-size:.72rem;padding:.25rem .5rem">Activity</button>':'')+(canRemind?'<button class="btn btn-ghost remind" style="font-size:.72rem;padding:.25rem .5rem">Remind</button>':'')+(req.status==='draft'?'<button class="btn btn-ghost send" style="font-size:.72rem;padding:.25rem .5rem">Send</button>':'<button class="btn btn-ghost links" style="font-size:.72rem;padding:.25rem .5rem">Links</button>')+(req.status==='completed'?'<button class="btn btn-ghost final" style="font-size:.72rem;padding:.25rem .5rem">PDF</button>':'')+(canVoid?'<button class="btn btn-ghost void" style="font-size:.72rem;padding:.25rem .5rem">Void</button>':'')+'<button class="btn btn-ghost delete" style="font-size:.72rem;padding:.25rem .5rem;color:var(--red)">Delete</button>';row.querySelector('.send')?.addEventListener('click',()=>signatureAction(req.id,'send'));row.querySelector('.activity')?.addEventListener('click',()=>showActivity(req.id));row.querySelector('.remind')?.addEventListener('click',()=>remindRequest(req.id));row.querySelector('.links')?.addEventListener('click',()=>loadRequestLinks(req.id));row.querySelector('.final')?.addEventListener('click',()=>downloadFinalPdf(req.id));row.querySelector('.void')?.addEventListener('click',()=>signatureAction(req.id,'void'));row.querySelector('.delete').addEventListener('click',()=>signatureAction(req.id,'delete'));list.appendChild(row);});
    }catch(err){list.innerHTML='<div style="color:var(--red);font-size:.85rem">'+escapeHtml(err.message)+'</div>';}
  }
  async function loadRequestLinks(id){const token=await auth.currentUser?.getIdToken(true);const res=await fetch(API+'/api/sign-requests/'+id,{headers:{Authorization:'Bearer '+token}});const data=await res.json();if(!res.ok)return toast(data.error||'Could not load links','error');showSignerLinks(data.recipients||[]);}
  async function signatureAction(id,action){if((action==='delete'||action==='void')&&!confirm(action==='delete'?'Permanently delete this request and stored PDF?':'Void this signature request?'))return;const token=await auth.currentUser?.getIdToken(true);const method=action==='delete'?'DELETE':'POST';try{const res=await fetch(API+'/api/sign-requests/'+id+(action==='delete'?'':'/'+action),{method,headers:{Authorization:'Bearer '+token}});const data=await res.json();if(!res.ok)throw new Error(data.error||'Action failed');toast(data.warning||('Request '+(action==='delete'?'deleted':action==='send'?'sent':'voided')),'success');loadRequests();}catch(err){toast(err.message,'error');}}
  async function downloadFinalPdf(id){try{const token=await auth.currentUser?.getIdToken(true);const res=await fetch(API+'/api/sign-requests/'+id+'/final-pdf',{headers:{Authorization:'Bearer '+token}});if(!res.ok){let msg='Final PDF not ready';try{msg=(await res.json()).error||msg;}catch(_){}throw new Error(msg);}const blob=await res.blob();triggerDownload(blob,'signature-request-'+id+'-completed.pdf');}catch(err){toast(err.message,'error');}}
  function showSignerLinks(signers){const wrap=document.getElementById('sigreq-links');wrap.style.display='block';wrap.innerHTML='<div class="card-title" style="margin-bottom:.5rem">Signer Links</div>';signers.filter(s=>s.url).forEach(s=>{const row=document.createElement('div');row.className='code-pill';row.style.cssText='width:100%;margin-bottom:.45rem;white-space:normal';row.innerHTML='<span style="flex:1;word-break:break-all">'+escapeHtml(s.email)+' - '+escapeHtml(s.url)+'</span><button class="copy-btn" type="button" title="Copy"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>';row.querySelector('button').addEventListener('click',()=>{navigator.clipboard.writeText(s.url);toast('Signer link copied','success');});wrap.appendChild(row);});}
  document.querySelectorAll('.sigreq-field-btn').forEach(btn=>{btn.draggable=true;btn.addEventListener('click',()=>addField(btn.dataset.field));btn.addEventListener('dragstart',e=>e.dataTransfer.setData('text/plain',btn.dataset.field));});
  stage.addEventListener('dragover',e=>e.preventDefault());stage.addEventListener('drop',e=>{e.preventDefault();const type=e.dataTransfer.getData('text/plain');if(!type)return;const r=stage.getBoundingClientRect();addField(type,(e.clientX-r.left)/canvas.offsetWidth,(e.clientY-r.top)/canvas.offsetHeight);});
  setupDrop(drop,fileInput,async files=>{
    const file=files[0];if(!file)return;
    if(file.size>8*1024*1024){toast('That PDF is over 8 MB. Compress it first, then try again.','error');return;}
    try{const pdfjsLib=await loadPdfjsLib();sigreqPdf=await pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;}
    catch(_){toast('That file could not be opened as a PDF.','error');return;}
    sigreqFile=file;sigreqPage=1;sigreqFields=[];
    document.getElementById('sigreq-drop-title').textContent='✓ '+file.name;
    document.getElementById('sigreq-drop-sub').textContent=sigreqPdf.numPages+' page'+(sigreqPdf.numPages===1?'':'s')+' · click to choose a different file';
    const title=document.getElementById('sigreq-title');if(!title.value)title.value=file.name.replace(/\.pdf$/i,'');
  });
  document.getElementById('sigreq-prev').addEventListener('click',()=>{if(sigreqPdf&&sigreqPage>1){sigreqPage--;renderPage();}});
  document.getElementById('sigreq-next').addEventListener('click',()=>{if(sigreqPdf&&sigreqPage<sigreqPdf.numPages){sigreqPage++;renderPage();}});
  function resetFlow(){
    sigreqFile=null;sigreqPdf=null;sigreqFields=[];ctx.clearRect(0,0,canvas.width,canvas.height);stage.querySelectorAll('.sigreq-box').forEach(el=>el.remove());
    resultEl.style.display='none';fileInput.value='';
    document.getElementById('sigreq-drop-title').textContent='Drop PDF here';document.getElementById('sigreq-drop-sub').textContent='or click to browse · up to 8 MB';
    document.getElementById('sigreq-title').value='';document.getElementById('sigreq-message').value='';
    recipientsEl.replaceChildren();addRecipient();
    document.getElementById('sigreq-review').style.display='';document.getElementById('sigreq-done').style.display='none';document.getElementById('sigreq-links').style.display='none';
    wizard.reset();
  }
  document.getElementById('sigreq-clear').addEventListener('click',resetFlow);
  document.getElementById('sigreq-restart').addEventListener('click',resetFlow);
  const SIGNER_COLORS=['#7c3aed','#0ea5e9','#f59e0b','#10b981','#ef4444','#ec4899','#6366f1','#84cc16','#14b8a6','#f97316'];
  function signerIndex(email){return recipients().findIndex(r=>r.email.toLowerCase()===String(email||'').toLowerCase());}
  function signerColor(email){const i=signerIndex(email);return SIGNER_COLORS[(i<0?0:i)%SIGNER_COLORS.length];}
  function signerName(email){const r=recipients()[signerIndex(email)];return r?(r.name||r.email):'';}
  function pickSigner(email){recipientsEl.querySelectorAll('.sigreq-recipient').forEach(row=>{row.querySelector('.sr-pick').checked=row.querySelector('.sr-email').value.trim().toLowerCase()===email;});renderChips();}
  function renderChips(){
    const wrap=document.getElementById('sigreq-signer-chips');wrap.replaceChildren();const active=selectedRecipient();
    recipients().forEach((r,i)=>{
      const email=r.email.toLowerCase();const count=sigreqFields.filter(f=>f.assignedTo===email).length;
      const chip=document.createElement('button');chip.type='button';chip.className='signer-chip'+(email===active?' active':'');chip.style.borderColor=email===active?signerColor(email):'';
      const dot=document.createElement('span');dot.className='dot';dot.style.background=signerColor(email);
      const label=document.createElement('span');label.textContent=(i+1)+'. '+(r.name||r.email);
      const c=document.createElement('span');c.className='count';c.textContent=count?'· '+count+' field'+(count===1?'':'s'):'· no fields yet';
      chip.append(dot,label,c);chip.addEventListener('click',()=>pickSigner(email));wrap.appendChild(chip);
    });
  }
  const EMAIL_OK=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function validateStep(step){
    if(step===1)return sigreqPdf?'':'Upload a PDF to continue.';
    if(step===2){
      const rows=Array.from(recipientsEl.querySelectorAll('.sigreq-recipient')).map(row=>({name:row.querySelector('.sr-name').value.trim(),email:row.querySelector('.sr-email').value.trim().toLowerCase()})).filter(r=>r.name||r.email);
      if(!rows.length)return 'Add at least one signer.';
      if(rows.length>10)return 'You can add up to 10 signers.';
      const bad=rows.find(r=>!r.name||!EMAIL_OK.test(r.email));if(bad)return 'Each signer needs a name and a valid email address.';
      if(new Set(rows.map(r=>r.email)).size!==rows.length)return 'Each signer needs a different email address.';
      // Fields for signers who were removed or re-typed no longer have an owner.
      const emails=new Set(rows.map(r=>r.email));sigreqFields=sigreqFields.filter(f=>emails.has(f.assignedTo));
      // Drop empty rows so the order numbers and chips match the real signers.
      recipientsEl.querySelectorAll('.sigreq-recipient').forEach(row=>{if(!row.querySelector('.sr-name').value.trim()&&!row.querySelector('.sr-email').value.trim())row.remove();});
      if(!recipientsEl.querySelector('.sr-pick:checked'))recipientsEl.querySelector('.sr-pick').checked=true;
      return '';
    }
    if(step===3){
      if(!sigreqFields.length)return 'Add at least one field to the document.';
      const missing=recipients().filter(r=>!sigreqFields.some(f=>f.assignedTo===r.email.toLowerCase()));
      if(missing.length)return (missing.map(r=>r.name||r.email).join(', '))+' still need'+(missing.length===1?'s':'')+' at least one field.';
      return '';
    }
    return '';
  }
  function renderReview(){
    const grid=document.getElementById('sigreq-review-grid');grid.replaceChildren();
    const add=(k,v)=>{const dt=document.createElement('dt');dt.textContent=k;const dd=document.createElement('dd');dd.textContent=v;grid.append(dt,dd);};
    add('Document',sigreqFile.name+' · '+sigreqPdf.numPages+' page'+(sigreqPdf.numPages===1?'':'s'));
    add('Request name',document.getElementById('sigreq-title').value.trim()||sigreqFile.name);
    add('Message',document.getElementById('sigreq-message').value.trim()||'(none)');
    add('Fields',sigreqFields.length+' in total');
    const list=document.getElementById('sigreq-review-signers');list.replaceChildren();
    recipients().forEach((r,i)=>{
      const row=document.createElement('div');row.className='review-signer';
      const order=document.createElement('span');order.className='order';order.textContent=i+1;order.style.borderColor=signerColor(r.email);
      const who=document.createElement('div');who.className='who';who.textContent=r.name;const small=document.createElement('small');small.textContent=r.email;who.appendChild(small);
      const count=sigreqFields.filter(f=>f.assignedTo===r.email.toLowerCase()).length;
      const c=document.createElement('span');c.style.cssText='color:var(--text3);font-size:.78rem';c.textContent=count+' field'+(count===1?'':'s');
      row.append(order,who,c);list.appendChild(row);
    });
  }
  const wizard=createWizard(document.getElementById('sigreq-wizard'),{
    validate:validateStep,
    onEnter(step){
      if(step===3){if(!recipientsEl.querySelector('.sr-pick:checked')){const first=recipientsEl.querySelector('.sr-pick');if(first)first.checked=true;}renderChips();renderPage();}
      if(step===4)renderReview();
    },
  });
  async function saveSigRequest(sendNow,btn){
    if(!sigreqFile)return toast('Upload a PDF first','error');
    const recips=recipients();if(!recips.length)return toast('Add at least one recipient','error');
    if(!sigreqFields.length)return toast('Place at least one field','error');
    const token=await auth.currentUser?.getIdToken(true);if(!token)return toast('Please sign in again','error');
    btn.disabled=true;showResult(resultEl,'info',sendNow?'Saving and sending signature request...':'Saving signature request draft...');
    try{const documentBase64=await fileToDataUrl(sigreqFile);const res=await fetch(API+'/api/sign-requests',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({title:document.getElementById('sigreq-title').value||sigreqFile.name,documentName:sigreqFile.name,documentBase64,message:document.getElementById('sigreq-message').value,recipients:recips,fields:sigreqFields,sendNow})});const data=await res.json();if(!res.ok)throw new Error(data.error||'Save failed');resultEl.style.display='none';
      document.getElementById('sigreq-review').style.display='none';document.getElementById('sigreq-done').style.display='';
      document.getElementById('sigreq-done-title').textContent=sendNow?'Sent for signature':'Draft saved';
      const first=recips[0];
      document.getElementById('sigreq-done-text').textContent=data.warning||(sendNow?`${first.name} has been emailed a secure signing link. You'll get an email when everyone has signed.`:'Your draft is saved in “Your signature requests” below. Send it whenever you are ready.');
      if(sendNow)showSignerLinks(data.signers||[]);loadRequests();loadSavedPeople(savedPeopleSelect);}
    catch(err){showResult(resultEl,'error',err.message);}finally{btn.disabled=false;}
  }
  // ── Templates: reusable field layouts keyed by signer order ──
  let sigTemplates=[];
  const tplSelect=document.getElementById('sigreq-template-select'),tplDelete=document.getElementById('sigreq-template-delete');
  async function loadTemplates(){
    const token=await auth.currentUser?.getIdToken();if(!token)return;
    try{const res=await fetch(API+'/api/sign-templates',{headers:{Authorization:'Bearer '+token}});const data=await res.json();if(!res.ok)throw new Error(data.error);sigTemplates=data.templates||[];}catch(_){sigTemplates=[];}
    tplSelect.replaceChildren();const first=document.createElement('option');first.value='';first.textContent=sigTemplates.length?'Use a saved layout…':'No templates yet';tplSelect.appendChild(first);
    sigTemplates.forEach(t=>{const o=document.createElement('option');o.value=t.id;o.textContent=`${t.name} · ${t.signer_count} signer${t.signer_count===1?'':'s'}`;tplSelect.appendChild(o);});
    tplDelete.style.display='none';
  }
  tplSelect.addEventListener('change',()=>{tplDelete.style.display=tplSelect.value?'':'none';});
  document.getElementById('sigreq-template-apply').addEventListener('click',()=>{
    const t=sigTemplates.find(x=>String(x.id)===tplSelect.value);if(!t)return toast('Choose a template first','error');
    const signers=recipients();
    if(signers.length<t.signer_count)return toast(`This template needs ${t.signer_count} signers - go back and add ${t.signer_count-signers.length} more.`,'error');
    const pages=sigreqPdf?.numPages||1;let skipped=0;
    sigreqFields=t.fields.filter(f=>{if(f.pageNumber>pages){skipped++;return false;}return true;}).map(f=>({type:f.type,assignedTo:signers[f.signer].email.toLowerCase(),pageNumber:f.pageNumber,x:f.x,y:f.y,width:f.width,height:f.height,label:f.label,required:f.required!==false}));
    renderFields();renderChips();
    toast(`Applied “${t.name}”`+(skipped?` (${skipped} field${skipped===1?'':'s'} skipped: this PDF has fewer pages)`:''),'success');
  });
  document.getElementById('sigreq-template-save').addEventListener('click',async function(){
    if(!sigreqFields.length)return toast('Place some fields first','error');
    const nameInput=prompt('Name this template (for example “Standard NDA”):');if(!nameInput||!nameInput.trim())return;
    const emails=recipients().map(r=>r.email.toLowerCase());
    const fields=sigreqFields.map(f=>({type:f.type,signer:Math.max(0,emails.indexOf(f.assignedTo)),pageNumber:f.pageNumber,x:f.x,y:f.y,width:f.width,height:f.height,label:f.label,required:f.required}));
    this.disabled=true;
    try{const token=await auth.currentUser.getIdToken();const res=await fetch(API+'/api/sign-templates',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({name:nameInput.trim(),pageCount:sigreqPdf?.numPages||null,fields})});const data=await res.json();if(!res.ok)throw new Error(data.error||'Could not save the template');toast('Template saved','success');await loadTemplates();tplSelect.value=String(data.template.id);tplDelete.style.display='';}
    catch(err){toast(err.message,'error');}finally{this.disabled=false;}
  });
  tplDelete.addEventListener('click',async()=>{
    const t=sigTemplates.find(x=>String(x.id)===tplSelect.value);if(!t||!confirm(`Delete the template “${t.name}”?`))return;
    try{const token=await auth.currentUser.getIdToken();const res=await fetch(API+'/api/sign-templates/'+t.id,{method:'DELETE',headers:{Authorization:'Bearer '+token}});if(!res.ok)throw new Error((await res.json()).error||'Could not delete');toast('Template deleted','success');loadTemplates();}catch(err){toast(err.message,'error');}
  });

  // ── Activity: who viewed, signed or declined, and when ──
  const EVENT_LABELS={draft_created:'Draft created',sent:'Sent',viewed:'Viewed',advanced:'Next signer emailed',completed:'Signed',request_completed:'Completed by everyone',declined:'Declined',voided:'Voided',reminder_sent:'Reminder sent',final_pdf_downloaded:'Final PDF downloaded',signer_copy_downloaded:'Signer downloaded copy'};
  async function showActivity(id){
    const box=document.getElementById('sigreq-activity');box.innerHTML='<div style="color:var(--muted);font-size:.85rem">Loading activity…</div>';
    try{
      const token=await auth.currentUser.getIdToken();const res=await fetch(API+'/api/sign-requests/'+id,{headers:{Authorization:'Bearer '+token}});const data=await res.json();if(!res.ok)throw new Error(data.error||'Could not load activity');
      const when=d=>d?new Date(d).toLocaleString():'-';
      box.replaceChildren();
      const title=document.createElement('div');title.className='card-title';title.textContent='Activity · '+data.request.title;box.appendChild(title);
      data.recipients.forEach((r,i)=>{
        const row=document.createElement('div');row.className='review-signer';
        const n=document.createElement('span');n.className='order';n.textContent=i+1;
        const who=document.createElement('div');who.className='who';who.textContent=r.name+' · '+r.status;
        const small=document.createElement('small');small.textContent=`${r.email} - viewed ${when(r.viewed_at)} · signed ${when(r.completed_at)}${r.declined_at?' · declined '+when(r.declined_at)+(r.decline_reason?` (“${r.decline_reason}”)`:''):''}`;
        who.appendChild(small);row.append(n,who);box.appendChild(row);
      });
      const log=document.createElement('div');log.style.cssText='margin-top:.75rem;font-size:.8rem;color:var(--text3);line-height:1.8';
      (data.events||[]).forEach(e=>{const line=document.createElement('div');line.textContent=`${when(e.created_at)} - ${EVENT_LABELS[e.event_type]||e.event_type}`;log.appendChild(line);});
      box.appendChild(log);box.scrollIntoView({behavior:'smooth',block:'nearest'});
    }catch(err){box.textContent=err.message;}
  }
  async function remindRequest(id){
    try{const token=await auth.currentUser.getIdToken();const res=await fetch(API+'/api/sign-requests/'+id+'/remind',{method:'POST',headers:{Authorization:'Bearer '+token}});const data=await res.json();if(!res.ok)throw new Error(data.error||'Could not send a reminder');toast('Reminder sent','success');}catch(err){toast(err.message,'error');}
  }
  document.getElementById('sigreq-save').addEventListener('click',function(){saveSigRequest(false,this);});
  document.getElementById('sigreq-send').addEventListener('click',function(){saveSigRequest(true,this);});
  document.addEventListener('nyx:panel-changed',e=>{if(e.detail&&e.detail.panel==='signrequest'){loadRequests();loadSavedPeople(savedPeopleSelect);loadTemplates();}});
})();

// ═══════════════════════════════════════════════════════
// DOCUMENT DISTRIBUTION
(function(){
  const fileInput=document.getElementById('dist-file'),drop=document.getElementById('dist-drop'),recipientsEl=document.getElementById('dist-recipients'),resultEl=document.getElementById('dist-result');
  if(!fileInput||!drop||!recipientsEl)return;
  let distFile=null;
  function fileToDataUrl(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});}
  function addRecipient(name='',email=''){if(name||email){const empty=Array.from(recipientsEl.querySelectorAll('.distribution-recipient')).find(r=>!r.querySelector('.dr-name').value.trim()&&!r.querySelector('.dr-email').value.trim());if(empty){empty.querySelector('.dr-name').value=name;empty.querySelector('.dr-email').value=email;return;}}const row=document.createElement('div');row.className='recipient-row distribution-recipient';const nameInput=document.createElement('input');nameInput.className='form-input dr-name';nameInput.placeholder='Name';nameInput.value=name;const emailInput=document.createElement('input');emailInput.className='form-input dr-email';emailInput.type='email';emailInput.placeholder='email@example.com';emailInput.value=email;const remove=document.createElement('button');remove.className='recipient-remove';remove.type='button';remove.title='Remove recipient';remove.setAttribute('aria-label','Remove recipient');remove.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';remove.addEventListener('click',()=>row.remove());row.append(nameInput,emailInput,remove);recipientsEl.appendChild(row);}
  function recipients(){return Array.from(recipientsEl.children).map(row=>({name:row.querySelector('.dr-name').value.trim(),email:row.querySelector('.dr-email').value.trim()})).filter(r=>r.name||r.email);}
  addRecipient();document.getElementById('dist-add-recipient').addEventListener('click',()=>addRecipient());const savedPeopleSelect=document.getElementById('dist-saved-person');document.getElementById('dist-use-saved').addEventListener('click',()=>useSavedPerson(savedPeopleSelect,addRecipient));
  setupDrop(drop,fileInput,files=>{
    const file=files[0];if(!file)return;
    if(file.size>8*1024*1024){toast('That PDF is over 8 MB. Compress it first, then try again.','error');return;}
    if(!/\.pdf$/i.test(file.name)&&file.type!=='application/pdf'){toast('Choose a PDF file.','error');return;}
    distFile=file;
    document.getElementById('dist-drop-title').textContent='✓ '+file.name;
    document.getElementById('dist-drop-sub').textContent=(file.size/1024/1024).toFixed(1)+' MB · click to choose a different file';
    const title=document.getElementById('dist-title');if(!title.value)title.value=file.name.replace(/\.pdf$/i,'');
  });
  const DIST_EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function updateCount(){const n=recipients().length;document.getElementById('dist-count').textContent=n?n+' recipient'+(n===1?'':'s')+' added':'';}
  recipientsEl.addEventListener('input',updateCount);
  recipientsEl.addEventListener('click',e=>{if(e.target.closest('.recipient-remove'))setTimeout(updateCount);});
  document.getElementById('dist-paste-open').addEventListener('click',()=>{const box=document.getElementById('dist-paste-box');box.style.display=box.style.display==='none'?'block':'none';if(box.style.display==='block')document.getElementById('dist-paste').focus();});
  document.getElementById('dist-paste-add').addEventListener('click',()=>{
    const lines=document.getElementById('dist-paste').value.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
    const existing=new Set(recipients().map(r=>r.email.toLowerCase()));
    let added=0,skipped=0;
    // Drop the empty starter row before adding pasted people.
    Array.from(recipientsEl.children).forEach(row=>{if(!row.querySelector('.dr-name').value.trim()&&!row.querySelector('.dr-email').value.trim())row.remove();});
    for(const line of lines){
      const emailMatch=line.match(/[^\s,;<>"]+@[^\s,;<>"]+\.[^\s,;<>"]+/);
      if(!emailMatch){skipped++;continue;}
      const email=emailMatch[0].toLowerCase();
      if(existing.has(email)){skipped++;continue;}
      let name=line.replace(emailMatch[0],'').replace(/[<>"]/g,'').replace(/[,;\t]+/g,' ').trim();
      if(!name)name=email.split('@')[0].replace(/[._-]+/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
      addRecipient(name,email);existing.add(email);added++;
    }
    if(!recipientsEl.children.length)addRecipient();
    document.getElementById('dist-paste').value='';
    document.getElementById('dist-paste-note').textContent=`Added ${added}`+(skipped?`, skipped ${skipped} (duplicate or no email)`:'');
    updateCount();
  });
  function validateDist(step){
    if(step===1){if(!distFile)return 'Upload a PDF to continue.';const pw=document.getElementById('dist-password').value;if(pw&&pw.length<4)return 'The link password must be at least 4 characters.';return '';}
    if(step===2){
      const list=recipients();
      if(!list.length)return 'Add at least one recipient.';
      if(list.length>250)return 'You can send to up to 250 people at once.';
      const bad=list.find(r=>!r.name||!DIST_EMAIL.test(r.email));if(bad)return 'Each recipient needs a name and a valid email address'+(bad.email?` (check ${bad.email})`:'')+'.';
      if(new Set(list.map(r=>r.email.toLowerCase())).size!==list.length)return 'The same email address appears more than once.';
    }
    return '';
  }
  function renderDistReview(){
    const grid=document.getElementById('dist-review-grid');grid.replaceChildren();
    const add=(k,v)=>{const dt=document.createElement('dt');dt.textContent=k;const dd=document.createElement('dd');dd.textContent=v;grid.append(dt,dd);};
    const list=recipients();
    add('Document',distFile.name);add('Name',document.getElementById('dist-title').value.trim()||distFile.name);add('Recipients',list.length+' '+(list.length===1?'person':'people'));
    add('Links work for',document.getElementById('dist-expiry').value+' days');add('Password',document.getElementById('dist-password').value?'Yes - recipients must enter it':'No');
    const box=document.getElementById('dist-review-list');box.replaceChildren();
    list.forEach((r,i)=>{const row=document.createElement('div');row.className='review-signer';const n=document.createElement('span');n.className='order';n.textContent=i+1;const who=document.createElement('div');who.className='who';who.textContent=r.name;const small=document.createElement('small');small.textContent=r.email;who.appendChild(small);row.append(n,who);box.appendChild(row);});
  }
  const distWizard=createWizard(document.getElementById('dist-wizard'),{validate:validateDist,onEnter(step){if(step===2)updateCount();if(step===3)renderDistReview();}});
  function resetDist(){
    distFile=null;fileInput.value='';resultEl.style.display='none';
    document.getElementById('dist-drop-title').textContent='Drop PDF here';document.getElementById('dist-drop-sub').textContent='or click to browse · up to 8 MB';
    document.getElementById('dist-title').value='';document.getElementById('dist-password').value='';document.getElementById('dist-expiry').value='30';recipientsEl.replaceChildren();addRecipient();
    document.getElementById('dist-paste-box').style.display='none';document.getElementById('dist-paste-note').textContent='';
    document.getElementById('dist-review').style.display='';document.getElementById('dist-done').style.display='none';
    distWizard.reset();
  }
  document.getElementById('dist-reset').addEventListener('click',resetDist);
  document.getElementById('dist-restart').addEventListener('click',resetDist);
  async function saveDistribution(sendNow,btn){if(!distFile)return toast('Upload a PDF first','error');const recips=recipients();if(!recips.length)return toast('Add at least one recipient','error');const token=await auth.currentUser?.getIdToken(true);if(!token)return toast('Please sign in again','error');btn.disabled=true;showResult(resultEl,'info',sendNow?'Sending document distribution...':'Saving distribution draft...');try{const documentBase64=await fileToDataUrl(distFile);const res=await fetch(API+'/api/distributions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({title:document.getElementById('dist-title').value||distFile.name,documentName:distFile.name,documentBase64,recipients:recips,sendNow,expiresDays:Number(document.getElementById('dist-expiry').value),password:document.getElementById('dist-password').value||undefined})});const data=await res.json();if(!res.ok)throw new Error(data.error||'Save failed');resultEl.style.display='none';
      document.getElementById('dist-review').style.display='none';document.getElementById('dist-done').style.display='';
      document.getElementById('dist-done-title').textContent=sendNow?'Sent':'Draft saved';
      document.getElementById('dist-done-text').textContent=data.warning||(sendNow?`${recips.length} ${recips.length===1?'person has':'people have'} been emailed a secure link. Track opens in “Your distributions” below.`:'Your draft is saved in “Your distributions” below. Send it whenever you are ready.');
      loadBatches();loadSavedPeople(savedPeopleSelect);}catch(err){showResult(resultEl,'error',err.message);}finally{btn.disabled=false;}}
  async function loadBatches(){const list=document.getElementById('dist-list'),token=await auth.currentUser?.getIdToken(true);if(!token)return;try{const res=await fetch(API+'/api/distributions',{headers:{Authorization:'Bearer '+token}});const data=await res.json();if(!res.ok)throw new Error(data.error||'Load failed');if(!data.batches.length){list.innerHTML='<div style="color:var(--muted);font-size:.85rem">No distribution batches yet.</div>';return;}list.innerHTML='';data.batches.forEach(batch=>{const row=document.createElement('div');row.className='recent-file-row';row.style.cursor='default';row.innerHTML='<span class="recent-fname">'+escapeHtml(batch.title)+'<br><span style="color:var(--muted);font-size:.72rem">'+Number(batch.recipient_count)+' recipients · '+Number(batch.opened_count)+' opened · '+Number(batch.failed_count)+' failed</span></span><span class="recent-tool-badge">'+escapeHtml(batch.status)+'</span><button class="btn btn-ghost inspect" style="font-size:.72rem;padding:.25rem .5rem">Inspect</button>'+(batch.status==='draft'?'<button class="btn btn-ghost send" style="font-size:.72rem;padding:.25rem .5rem">Send</button>':'')+(['draft','sent'].includes(batch.status)?'<button class="btn btn-ghost revoke" style="font-size:.72rem;padding:.25rem .5rem">Revoke</button>':'')+'<button class="btn btn-ghost delete" style="font-size:.72rem;padding:.25rem .5rem;color:var(--red)">Delete</button>';row.querySelector('.inspect').addEventListener('click',()=>loadBatchDetail(batch.id));row.querySelector('.send')?.addEventListener('click',()=>distributionAction(batch.id,'send'));row.querySelector('.revoke')?.addEventListener('click',()=>distributionAction(batch.id,'revoke'));row.querySelector('.delete').addEventListener('click',()=>distributionAction(batch.id,'delete'));list.appendChild(row);});}catch(err){list.innerHTML='<div style="color:var(--red);font-size:.85rem">'+escapeHtml(err.message)+'</div>';}}
  async function loadBatchDetail(id){const detail=document.getElementById('dist-detail'),token=await auth.currentUser?.getIdToken(true);const res=await fetch(API+'/api/distributions/'+id,{headers:{Authorization:'Bearer '+token}});const data=await res.json();if(!res.ok)return toast(data.error||'Could not load batch','error');detail.innerHTML='<div class="card-title">Recipients</div>';data.recipients.forEach(r=>{const row=document.createElement('div');row.className='recent-file-row';row.style.cursor='default';row.innerHTML='<span class="recent-fname">'+escapeHtml(r.name)+'<br><span style="color:var(--muted);font-size:.72rem">'+escapeHtml(r.email)+'</span></span><span class="recent-tool-badge">'+escapeHtml(r.status)+'</span>';detail.appendChild(row);});}
  async function distributionAction(id,action){if((action==='delete'||action==='revoke')&&!confirm(action==='delete'?'Permanently delete this distribution and stored PDF?':'Revoke every recipient link?'))return;const token=await auth.currentUser?.getIdToken(true);const method=action==='delete'?'DELETE':'POST';try{const res=await fetch(API+'/api/distributions/'+id+(action==='delete'?'':'/'+action),{method,headers:{Authorization:'Bearer '+token}});const data=await res.json();if(!res.ok)throw new Error(data.error||'Action failed');toast(data.warning||('Distribution '+(action==='delete'?'deleted':action==='send'?'sent':'revoked')),'success');document.getElementById('dist-detail').replaceChildren();loadBatches();}catch(err){toast(err.message,'error');}}
  document.getElementById('dist-send').addEventListener('click',function(){saveDistribution(true,this);});document.getElementById('dist-save').addEventListener('click',function(){saveDistribution(false,this);});document.getElementById('dist-refresh').addEventListener('click',loadBatches);document.addEventListener('nyx:panel-changed',e=>{if(e.detail&&e.detail.panel==='distribution'){loadBatches();loadSavedPeople(savedPeopleSelect);}});
})();

// ═══════════════════════════════════════════════════════
// ALERTS PANEL
(function(){
  const list=document.getElementById('alerts-list'),refresh=document.getElementById('alerts-refresh');
  if(!list||!refresh)return;
  async function loadAlerts(){
    const token=await auth.currentUser?.getIdToken(true);if(!token)return;
    list.innerHTML='<div style="color:var(--muted);font-size:.85rem">Loading alerts…</div>';
    try{const res=await fetch(API+'/api/sign-requests/alerts?windowDays=30&upcomingDays=7',{headers:{Authorization:'Bearer '+token}});const data=await res.json();if(!res.ok)throw new Error(data.error||'Failed to load alerts');
      const active=(data.alerts||[]).filter(a=>!a.acknowledged);
      if(!active.length){list.innerHTML='<div class="result-box success visible"><div class="rtext">No active document alerts.</div></div>';return;}
      list.innerHTML='';active.forEach(alert=>{const row=document.createElement('div');row.className='recent-file-row';row.style.cursor='default';const sev=alert.severity==='expired'?'Expired':alert.severity==='upcoming'?'Expiring soon':'Notice';row.innerHTML='<span class="recent-fname">'+escapeHtml(alert.title)+'<br><span style="color:var(--muted);font-size:.72rem">'+escapeHtml(alert.document_name)+' · '+sev+' · '+Number(alert.days_remaining)+' day(s)</span></span><span class="recent-tool-badge">'+escapeHtml(alert.status)+'</span><button class="btn btn-ghost" style="font-size:.72rem;padding:.25rem .5rem">Acknowledge</button>';row.querySelector('button').addEventListener('click',()=>ackAlert(alert.id));list.appendChild(row);});
    }catch(err){list.innerHTML='<div class="result-box error visible"><div class="rtext">'+escapeHtml(err.message)+'</div></div>';}
  }
  async function ackAlert(id){const token=await auth.currentUser?.getIdToken(true);if(!token)return;try{const res=await fetch(API+'/api/sign-requests/alerts/'+id+'/ack',{method:'POST',headers:{Authorization:'Bearer '+token}});if(!res.ok)throw new Error('Could not acknowledge alert');toast('Alert acknowledged','success');loadAlerts();}catch(err){toast(err.message,'error');}}
  refresh.addEventListener('click',loadAlerts);
  document.addEventListener('nyx:panel-changed',e=>{if(e.detail&&e.detail.panel==='alerts')loadAlerts();});
})();

// ═══════════════════════════════════════════════════════
// ANNOTATE PDF
{
  let annPdfDoc = null, annPdfJsDoc = null, annCurrentPage = 1, annTotalPages = 1;
  let annTool = 'highlight', annIsDrawing = false;
  let annStartX = 0, annStartY = 0;
  let annStrokes = {};
  let annRenderCanvas = null;
  const annCanvas = document.getElementById('ann-canvas');
  const annCtx = annCanvas ? annCanvas.getContext('2d') : null;

  async function annLoad(file) {
    const resultEl = document.getElementById('ann-result');
    showResult(resultEl, 'info', 'Loading PDF...'); resultEl.style.display = 'block';
    try {
      const { PDFDocument } = await loadPdfLib();
      const pdfjsLib = await loadPdfjsLib();
      const ab = await file.arrayBuffer();
      annPdfDoc = await PDFDocument.load(ab.slice(0));
      annPdfJsDoc = await pdfjsLib.getDocument({ data: ab }).promise;
      annTotalPages = annPdfJsDoc.numPages;
      annCurrentPage = 1;
      annStrokes = {};
      document.getElementById('ann-editor').style.display = 'block';
      resultEl.style.display = 'none';
      await annRenderPage();
    } catch(e) { showResult(resultEl, 'error', 'Error: ' + e.message); }
  }
  setupDrop(document.getElementById('ann-drop'), document.getElementById('ann-file'), files => { if (files[0]) annLoad(files[0]); });
  document.getElementById('ann-file') && document.getElementById('ann-file').addEventListener('change', function() { if (this.files[0]) annLoad(this.files[0]); });

  async function annRenderPage() {
    if (!annPdfJsDoc) return;
    const page = await annPdfJsDoc.getPage(annCurrentPage);
    const viewport = page.getViewport({ scale: 1.5 });
    annCanvas.width = viewport.width;
    annCanvas.height = viewport.height;
    annRenderCanvas = document.createElement('canvas');
    annRenderCanvas.width = viewport.width;
    annRenderCanvas.height = viewport.height;
    await page.render({ canvasContext: annRenderCanvas.getContext('2d'), viewport }).promise;
    annRedrawCanvas();
    document.getElementById('ann-page-info').textContent = annCurrentPage + ' / ' + annTotalPages;
  }
  function annRedrawCanvas() {
    annCtx.clearRect(0, 0, annCanvas.width, annCanvas.height);
    annCtx.drawImage(annRenderCanvas, 0, 0);
    const strokes = annStrokes[annCurrentPage] || [];
    for (const s of strokes) annDrawStroke(s);
  }
  function annDrawStroke(s) {
    annCtx.save();
    if (s.type === 'highlight') { annCtx.globalAlpha = 0.35; annCtx.fillStyle = s.color; annCtx.fillRect(s.x, s.y, s.w, s.h); }
    else if (s.type === 'rect') { annCtx.globalAlpha = 0.8; annCtx.strokeStyle = s.color; annCtx.lineWidth = s.lw; annCtx.strokeRect(s.x, s.y, s.w, s.h); }
    else if (s.type === 'pen') { annCtx.globalAlpha = 1; annCtx.strokeStyle = s.color; annCtx.lineWidth = s.lw; annCtx.lineCap = 'round'; annCtx.lineJoin = 'round'; annCtx.beginPath(); s.pts.forEach((p,i) => i === 0 ? annCtx.moveTo(p[0], p[1]) : annCtx.lineTo(p[0], p[1])); annCtx.stroke(); }
    else if (s.type === 'text') { annCtx.globalAlpha = 1; annCtx.fillStyle = s.color; annCtx.font = '16px Inter, sans-serif'; annCtx.fillText(s.text, s.x, s.y); }
    annCtx.restore();
  }
  document.querySelectorAll('.ann-tool').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.ann-tool').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    annTool = btn.dataset.tool;
  }));
  document.getElementById('ann-prev') && document.getElementById('ann-prev').addEventListener('click', async () => { if (annCurrentPage > 1) { annCurrentPage--; await annRenderPage(); } });
  document.getElementById('ann-next') && document.getElementById('ann-next').addEventListener('click', async () => { if (annCurrentPage < annTotalPages) { annCurrentPage++; await annRenderPage(); } });
  document.getElementById('ann-undo-btn') && document.getElementById('ann-undo-btn').addEventListener('click', () => { if (annStrokes[annCurrentPage]) { annStrokes[annCurrentPage].pop(); annRedrawCanvas(); } });

  let annPenPts = [];
  function annGetPos(e) {
    const r = annCanvas.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    return [(src.clientX - r.left) * (annCanvas.width / r.width), (src.clientY - r.top) * (annCanvas.height / r.height)];
  }
  if (annCanvas) {
    annCanvas.addEventListener('mousedown', e => { annIsDrawing = true; [annStartX, annStartY] = annGetPos(e); annPenPts = [[annStartX, annStartY]]; });
    annCanvas.addEventListener('touchstart', e => { e.preventDefault(); annIsDrawing = true; [annStartX, annStartY] = annGetPos(e); annPenPts = [[annStartX, annStartY]]; }, {passive:false});
    annCanvas.addEventListener('mousemove', e => {
      if (!annIsDrawing) return;
      const [x,y] = annGetPos(e);
      annPenPts.push([x,y]);
      annRedrawCanvas();
      const color = document.getElementById('ann-color').value;
      const lw = parseInt(document.getElementById('ann-linewidth').value);
      if (annTool === 'pen') annDrawStroke({type:'pen', color, lw, pts: annPenPts});
      else if (annTool === 'highlight') annDrawStroke({type:'highlight', color, x:annStartX, y:annStartY, w:x-annStartX, h:y-annStartY});
      else if (annTool === 'rect') annDrawStroke({type:'rect', color, lw, x:annStartX, y:annStartY, w:x-annStartX, h:y-annStartY});
    });
    annCanvas.addEventListener('touchmove', e => { e.preventDefault(); if (!annIsDrawing) return; const [x,y] = annGetPos(e); annPenPts.push([x,y]); annRedrawCanvas(); const color = document.getElementById('ann-color').value; const lw = parseInt(document.getElementById('ann-linewidth').value); if (annTool === 'pen') annDrawStroke({type:'pen', color, lw, pts: annPenPts}); else if (annTool === 'highlight') annDrawStroke({type:'highlight', color, x:annStartX, y:annStartY, w:x-annStartX, h:y-annStartY}); else if (annTool === 'rect') annDrawStroke({type:'rect', color, lw, x:annStartX, y:annStartY, w:x-annStartX, h:y-annStartY}); }, {passive:false});
    annCanvas.addEventListener('mouseup', async e => {
      if (!annIsDrawing) return; annIsDrawing = false;
      const [x,y] = annGetPos(e);
      const color = document.getElementById('ann-color').value;
      const lw = parseInt(document.getElementById('ann-linewidth').value);
      if (!annStrokes[annCurrentPage]) annStrokes[annCurrentPage] = [];
      if (annTool === 'pen') annStrokes[annCurrentPage].push({type:'pen', color, lw, pts: annPenPts.slice()});
      else if (annTool === 'highlight') annStrokes[annCurrentPage].push({type:'highlight', color, x:annStartX, y:annStartY, w:x-annStartX, h:y-annStartY});
      else if (annTool === 'rect') annStrokes[annCurrentPage].push({type:'rect', color, lw, x:annStartX, y:annStartY, w:x-annStartX, h:y-annStartY});
      else if (annTool === 'text') { const txt = prompt('Enter annotation text:'); if (txt) annStrokes[annCurrentPage].push({type:'text', color, x:annStartX, y:annStartY, text:txt}); }
      annRedrawCanvas();
    });
    annCanvas.addEventListener('touchend', () => { if (!annIsDrawing) return; annIsDrawing = false; const color = document.getElementById('ann-color').value; const lw = parseInt(document.getElementById('ann-linewidth').value); if (!annStrokes[annCurrentPage]) annStrokes[annCurrentPage] = []; if (annTool === 'pen') annStrokes[annCurrentPage].push({type:'pen', color, lw, pts: annPenPts.slice()}); annRedrawCanvas(); });
  }
  document.getElementById('ann-save-btn') && document.getElementById('ann-save-btn').addEventListener('click', async () => {
    if (!annPdfDoc) return toast('No PDF loaded', 'error');
    const btn = document.getElementById('ann-save-btn');
    const resultEl = document.getElementById('ann-result');
    btn.innerHTML = '<span class="inline-spinner"></span> Saving...'; btn.disabled = true;
    showResult(resultEl, 'info', 'Flattening annotations...'); resultEl.style.display = 'block';
    try {
      const pdfjsLib = await loadPdfjsLib();
      const pdfPages = annPdfDoc.getPages();
      for (let pgNum = 1; pgNum <= annTotalPages; pgNum++) {
        const page = await annPdfJsDoc.getPage(pgNum);
        const viewport = page.getViewport({ scale: 1.5 });
        const c = document.createElement('canvas');
        c.width = viewport.width; c.height = viewport.height;
        const ctx2 = c.getContext('2d');
        await page.render({ canvasContext: ctx2, viewport }).promise;
        const strokes = annStrokes[pgNum] || [];
        for (const s of strokes) {
          ctx2.save();
          if (s.type === 'highlight') { ctx2.globalAlpha = 0.35; ctx2.fillStyle = s.color; ctx2.fillRect(s.x, s.y, s.w, s.h); }
          else if (s.type === 'rect') { ctx2.globalAlpha = 0.8; ctx2.strokeStyle = s.color; ctx2.lineWidth = s.lw; ctx2.strokeRect(s.x, s.y, s.w, s.h); }
          else if (s.type === 'pen') { ctx2.globalAlpha = 1; ctx2.strokeStyle = s.color; ctx2.lineWidth = s.lw; ctx2.lineCap = 'round'; ctx2.lineJoin = 'round'; ctx2.beginPath(); s.pts.forEach((p,i) => i===0?ctx2.moveTo(p[0],p[1]):ctx2.lineTo(p[0],p[1])); ctx2.stroke(); }
          else if (s.type === 'text') { ctx2.globalAlpha = 1; ctx2.fillStyle = s.color; ctx2.font = '16px sans-serif'; ctx2.fillText(s.text, s.x, s.y); }
          ctx2.restore();
        }
        const blob = await new Promise(res => c.toBlob(res, 'image/png'));
        const imgBytes = await blob.arrayBuffer();
        const pdfPage = pdfPages[pgNum - 1];
        const { width, height } = pdfPage.getSize();
        const embImg = await annPdfDoc.embedPng(imgBytes);
        pdfPage.drawImage(embImg, { x:0, y:0, width, height });
      }
      const out = await annPdfDoc.save();
      const origName = document.getElementById('ann-file').files[0]?.name || 'annotated.pdf';
      triggerDownload(new Blob([out], { type:'application/pdf' }), origName.replace(/.pdf$/i,'') + '-annotated.pdf');
      Stats.inc(0);
      showResult(resultEl, 'success', 'Annotated PDF ready! Download started.');
    } catch(e) { showResult(resultEl, 'error', 'Error: ' + e.message); }
    finally { btn.innerHTML = 'Save Annotated PDF'; btn.disabled = false; }
  });
}

// ═══════════════════════════════════════════════════════
// PAGE MANAGER
{
  let pmPdfBytes = null, pmOrder = [];
  const pmThumbs = document.getElementById('pm-thumbnails');

  async function pmLoad(file) {
    const resultEl = document.getElementById('pm-result');
    showResult(resultEl, 'info', 'Loading thumbnails...'); resultEl.style.display = 'block';
    try {
      const pdfjsLib = await loadPdfjsLib();
      pmPdfBytes = await file.arrayBuffer();
      const pdfJsDoc = await pdfjsLib.getDocument({ data: pmPdfBytes.slice(0) }).promise;
      const n = pdfJsDoc.numPages;
      pmOrder = Array.from({length: n}, (_, i) => i);
      pmThumbs.innerHTML = '';
      for (let i = 0; i < n; i++) {
        const pg = await pdfJsDoc.getPage(i + 1);
        const vp = pg.getViewport({ scale: 0.35 });
        const c = document.createElement('canvas');
        c.width = vp.width; c.height = vp.height;
        await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        const thumb = document.createElement('div');
        thumb.dataset.idx = String(i);
        thumb.draggable = true;
        thumb.className = 'pm-thumb'; thumb.style.cssText = 'display:inline-block;text-align:center;cursor:grab;position:relative;border:2px solid var(--border);border-radius:6px;padding:4px;background:var(--surface2)';
        const delBtn = document.createElement('button');
        delBtn.style.cssText = 'position:absolute;top:2px;right:2px;background:#dc2626;color:#fff;border:none;border-radius:50%;width:20px;height:20px;font-size:12px;cursor:pointer;line-height:1';
        delBtn.title = 'Delete page';
        delBtn.textContent = 'x';
        const label = document.createElement('p');
        label.style.cssText = 'font-size:.75rem;color:var(--text-muted);margin:4px 0 0';
        label.textContent = 'Page ' + (i+1);
        delBtn.addEventListener('click', () => {
          const idx = parseInt(thumb.dataset.idx);
          pmOrder = pmOrder.filter(x => x !== idx);
          thumb.remove();
          toast('Page removed');
        });
        thumb.appendChild(delBtn);
        thumb.appendChild(c);
        thumb.appendChild(label);
        pmThumbs.appendChild(thumb);
      }
      let pmDragSrc = null;
      pmThumbs.querySelectorAll('[draggable]').forEach(el => {
        el.addEventListener('dragstart', () => { pmDragSrc = el; el.style.opacity = '0.5'; });
        el.addEventListener('dragend', () => el.style.opacity = '1');
        el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('pm-drag-over'); });
        el.addEventListener('dragleave', () => el.classList.remove('pm-drag-over'));
        el.addEventListener('drop', e => {
          e.preventDefault();
          el.classList.remove('pm-drag-over');
          if (pmDragSrc === el) return;
          const fromIdx = parseInt(pmDragSrc.dataset.idx);
          const toIdx = parseInt(el.dataset.idx);
          const fi = pmOrder.indexOf(fromIdx);
          const ti = pmOrder.indexOf(toIdx);
          pmOrder.splice(fi, 1);
          pmOrder.splice(ti, 0, fromIdx);
          pmThumbs.insertBefore(pmDragSrc, el);
        });
      });
      // Touch drag-to-reorder
      (function addTouchDrag() {
        let touchSrc = null, touchClone = null;
        function getThumbAt(x, y) {
          const els = pmThumbs.querySelectorAll("[draggable]");
          for (const t of els) {
            const r = t.getBoundingClientRect();
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return t;
          }
          return null;
        }
        pmThumbs.querySelectorAll("[draggable]").forEach(el => {
          el.addEventListener("touchstart", e => {
            e.preventDefault();
            touchSrc = el;
            el.style.opacity = "0.5";
            touchClone = el.cloneNode(true);
            touchClone.style.cssText = "position:fixed;pointer-events:none;opacity:.7;z-index:9999;border:2px solid var(--accent);border-radius:6px;";
            const r = el.getBoundingClientRect();
            touchClone.style.width = r.width + "px";
            touchClone.style.height = r.height + "px";
            document.body.appendChild(touchClone);
          }, { passive: false });
          el.addEventListener("touchmove", e => {
            e.preventDefault();
            if (!touchSrc || !touchClone) return;
            const t = e.touches[0];
            touchClone.style.left = (t.clientX - parseInt(touchClone.style.width) / 2) + "px";
            touchClone.style.top = (t.clientY - parseInt(touchClone.style.height) / 2) + "px";
            pmThumbs.querySelectorAll("[draggable]").forEach(x => x.classList.remove("pm-drag-over"));
            const over = getThumbAt(t.clientX, t.clientY);
            if (over && over !== touchSrc) over.classList.add("pm-drag-over");
          }, { passive: false });
          el.addEventListener("touchend", e => {
            e.preventDefault();
            if (touchClone) { touchClone.remove(); touchClone = null; }
            if (!touchSrc) return;
            touchSrc.style.opacity = "1";
            const t = e.changedTouches[0];
            const target = getThumbAt(t.clientX, t.clientY);
            pmThumbs.querySelectorAll("[draggable]").forEach(x => x.classList.remove("pm-drag-over"));
            if (target && target !== touchSrc) {
              const fromIdx = parseInt(touchSrc.dataset.idx);
              const toIdx = parseInt(target.dataset.idx);
              const fi = pmOrder.indexOf(fromIdx);
              const ti = pmOrder.indexOf(toIdx);
              pmOrder.splice(fi, 1);
              pmOrder.splice(ti, 0, fromIdx);
              pmThumbs.insertBefore(touchSrc, target);
            }
            touchSrc = null;
          }, { passive: false });
        });
      })();

      document.getElementById('pm-grid').style.display = 'block';
      resultEl.style.display = 'none';
    } catch(e) { showResult(resultEl, 'error', 'Error: ' + e.message); }
  }
  setupDrop(document.getElementById('pm-drop'), document.getElementById('pm-file'), files => { if (files[0]) pmLoad(files[0]); });
  document.getElementById('pm-file') && document.getElementById('pm-file').addEventListener('change', function() { if (this.files[0]) pmLoad(this.files[0]); });

  document.getElementById('pm-save-btn') && document.getElementById('pm-save-btn').addEventListener('click', async () => {
    if (!pmPdfBytes || !pmOrder.length) return toast('No PDF loaded', 'error');
    const btn = document.getElementById('pm-save-btn');
    const resultEl = document.getElementById('pm-result');
    btn.innerHTML = '<span class="inline-spinner"></span> Saving...'; btn.disabled = true;
    showResult(resultEl, 'info', 'Rebuilding PDF...'); resultEl.style.display = 'block';
    try {
      const { PDFDocument } = await loadPdfLib();
      const srcDoc = await PDFDocument.load(pmPdfBytes);
      const newDoc = await PDFDocument.create();
      const copied = await newDoc.copyPages(srcDoc, pmOrder);
      copied.forEach(p => newDoc.addPage(p));
      const out = await newDoc.save();
      const fname = document.getElementById('pm-file').files[0]?.name || 'reordered.pdf';
      triggerDownload(new Blob([out], {type:'application/pdf'}), fname.replace(/.pdf$/i,'') + '-reordered.pdf');
      Stats.inc(pmPdfBytes.byteLength / 1048576);
      showResult(resultEl, 'success', 'PDF saved with ' + pmOrder.length + ' pages! Download started.');
    } catch(e) { showResult(resultEl, 'error', 'Error: ' + e.message); }
    finally { btn.innerHTML = 'Save Reordered PDF'; btn.disabled = false; }
  });
}

// ═══════════════════════════════════════════════════════
// PAGE NUMBERS
{
  setupDrop(document.getElementById('num-drop'), document.getElementById('num-file'), () => {});
  document.getElementById('num-apply-btn') && document.getElementById('num-apply-btn').addEventListener('click', async () => {
    const file = document.getElementById('num-file').files[0];
    if (!file) return toast('Please upload a PDF', 'error');
    const btn = document.getElementById('num-apply-btn');
    const resultEl = document.getElementById('num-result');
    btn.innerHTML = '<span class="inline-spinner"></span> Adding numbers...'; btn.disabled = true;
    showResult(resultEl, 'info', 'Stamping page numbers...'); resultEl.style.display = 'block';
    try {
      const { PDFDocument, rgb, StandardFonts } = await loadPdfLib();
      const pdfBytes = await file.arrayBuffer();
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const pages = pdfDoc.getPages();
      const total = pages.length;
      const startNum = parseInt(document.getElementById('num-start').value) || 1;
      const fontSize = parseInt(document.getElementById('num-fontsize').value) || 12;
      const pos = document.getElementById('num-position').value;
      const fmt = document.getElementById('num-format').value;
      const skipFirst = document.getElementById('num-skip-first').checked;
      const hexColor = document.getElementById('num-color').value;
      const rr = parseInt(hexColor.slice(1,3),16)/255, gg = parseInt(hexColor.slice(3,5),16)/255, bb = parseInt(hexColor.slice(5,7),16)/255;
      const color = rgb(rr,gg,bb);
      pages.forEach((pg, i) => {
        if (skipFirst && i === 0) return;
        const n = startNum + i;
        const label = fmt === 'n' ? String(n) : fmt === 'page_n' ? 'Page ' + n : 'Page ' + n + ' of ' + total;
        const { width, height } = pg.getSize();
        const tw = font.widthOfTextAtSize(label, fontSize);
        const margin = 24;
        let x, y;
        if (pos === 'bc') { x = (width - tw) / 2; y = margin; }
        else if (pos === 'br') { x = width - tw - margin; y = margin; }
        else if (pos === 'bl') { x = margin; y = margin; }
        else if (pos === 'tc') { x = (width - tw) / 2; y = height - margin - fontSize; }
        else if (pos === 'tr') { x = width - tw - margin; y = height - margin - fontSize; }
        else { x = margin; y = height - margin - fontSize; }
        pg.drawText(label, { x, y, size: fontSize, font, color });
      });
      const out = await pdfDoc.save();
      triggerDownload(new Blob([out], {type:'application/pdf'}), file.name.replace(/.pdf$/i,'') + '-numbered.pdf');
      Stats.inc(file.size / 1048576);
      showResult(resultEl, 'success', 'Page numbers added to ' + total + ' pages! Download started.');
    } catch(e) { showResult(resultEl, 'error', 'Error: ' + e.message); }
    finally { btn.innerHTML = 'Add Page Numbers'; btn.disabled = false; }
  });
}

// ═══════════════════════════════════════════════════════
// REDACT PDF
{
  let redactPdfDoc = null, redactPdfJsDoc = null, redactCurrentPage = 1, redactTotalPages = 1;
  let redactIsDrawing = false, redactStartX = 0, redactStartY = 0;
  let redactBoxes = {};
  let redactRenderCanvas = null;
  const redactCanvas = document.getElementById('redact-canvas');
  const redactCtx = redactCanvas ? redactCanvas.getContext('2d') : null;

  async function redactLoad(file) {
    const resultEl = document.getElementById('redact-result');
    showResult(resultEl, 'info', 'Loading PDF...'); resultEl.style.display = 'block';
    try {
      const { PDFDocument } = await loadPdfLib();
      const pdfjsLib = await loadPdfjsLib();
      const ab = await file.arrayBuffer();
      redactPdfDoc = await PDFDocument.load(ab.slice(0));
      redactPdfJsDoc = await pdfjsLib.getDocument({ data: ab }).promise;
      redactTotalPages = redactPdfJsDoc.numPages;
      redactCurrentPage = 1;
      redactBoxes = {};
      document.getElementById('redact-editor').style.display = 'block';
      resultEl.style.display = 'none';
      await redactRenderPage();
    } catch(e) { showResult(resultEl, 'error', 'Error: ' + e.message); }
  }
  setupDrop(document.getElementById('redact-drop'), document.getElementById('redact-file'), files => { if (files[0]) redactLoad(files[0]); });
  document.getElementById('redact-file') && document.getElementById('redact-file').addEventListener('change', function() { if (this.files[0]) redactLoad(this.files[0]); });

  async function redactRenderPage() {
    if (!redactPdfJsDoc) return;
    const page = await redactPdfJsDoc.getPage(redactCurrentPage);
    const viewport = page.getViewport({ scale: 1.5 });
    redactCanvas.width = viewport.width;
    redactCanvas.height = viewport.height;
    redactRenderCanvas = document.createElement('canvas');
    redactRenderCanvas.width = viewport.width;
    redactRenderCanvas.height = viewport.height;
    await page.render({ canvasContext: redactRenderCanvas.getContext('2d'), viewport }).promise;
    redactRedraw();
    document.getElementById('redact-page-info').textContent = redactCurrentPage + ' / ' + redactTotalPages;
  }
  function redactRedraw() {
    redactCtx.clearRect(0,0,redactCanvas.width,redactCanvas.height);
    redactCtx.drawImage(redactRenderCanvas,0,0);
    redactCtx.fillStyle = '#000';
    (redactBoxes[redactCurrentPage] || []).forEach(b => redactCtx.fillRect(b.x, b.y, b.w, b.h));
  }
  function redactGetPos(e) {
    const r = redactCanvas.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    return [(src.clientX - r.left) * (redactCanvas.width / r.width), (src.clientY - r.top) * (redactCanvas.height / r.height)];
  }
  if (redactCanvas) {
    redactCanvas.addEventListener('mousedown', e => { redactIsDrawing = true; [redactStartX, redactStartY] = redactGetPos(e); });
    redactCanvas.addEventListener('touchstart', e => { e.preventDefault(); redactIsDrawing = true; [redactStartX, redactStartY] = redactGetPos(e); }, {passive:false});
    redactCanvas.addEventListener('mousemove', e => { if (!redactIsDrawing) return; const [x,y] = redactGetPos(e); redactRedraw(); redactCtx.fillStyle = 'rgba(0,0,0,0.5)'; redactCtx.fillRect(redactStartX, redactStartY, x-redactStartX, y-redactStartY); });
    redactCanvas.addEventListener('touchmove', e => { e.preventDefault(); if (!redactIsDrawing) return; const [x,y] = redactGetPos(e); redactRedraw(); redactCtx.fillStyle = 'rgba(0,0,0,0.5)'; redactCtx.fillRect(redactStartX, redactStartY, x-redactStartX, y-redactStartY); }, {passive:false});
    redactCanvas.addEventListener('mouseup', e => {
      if (!redactIsDrawing) return; redactIsDrawing = false;
      const [x,y] = redactGetPos(e);
      if (!redactBoxes[redactCurrentPage]) redactBoxes[redactCurrentPage] = [];
      const w = x - redactStartX, h = y - redactStartY;
      if (Math.abs(w) > 4 && Math.abs(h) > 4) redactBoxes[redactCurrentPage].push({x:redactStartX, y:redactStartY, w, h});
      redactRedraw();
    });
    redactCanvas.addEventListener('touchend', () => { if (!redactIsDrawing) return; redactIsDrawing = false; redactRedraw(); });
  }
  document.getElementById('redact-undo-btn') && document.getElementById('redact-undo-btn').addEventListener('click', () => { if (redactBoxes[redactCurrentPage]) { redactBoxes[redactCurrentPage].pop(); redactRedraw(); } });
  document.getElementById('redact-prev') && document.getElementById('redact-prev').addEventListener('click', async () => { if (redactCurrentPage > 1) { redactCurrentPage--; await redactRenderPage(); } });
  document.getElementById('redact-next') && document.getElementById('redact-next').addEventListener('click', async () => { if (redactCurrentPage < redactTotalPages) { redactCurrentPage++; await redactRenderPage(); } });

  document.getElementById('redact-save-btn') && document.getElementById('redact-save-btn').addEventListener('click', async () => {
    if (!redactPdfDoc) return toast('No PDF loaded', 'error');
    const btn = document.getElementById('redact-save-btn');
    const resultEl = document.getElementById('redact-result');
    btn.innerHTML = '<span class="inline-spinner"></span> Redacting...'; btn.disabled = true;
    showResult(resultEl, 'info', 'Burning redactions...'); resultEl.style.display = 'block';
    try {
      const { PDFDocument, rgb } = await loadPdfLib();
      const pdfPages = redactPdfDoc.getPages();
      for (let pgNum = 1; pgNum <= redactTotalPages; pgNum++) {
        const boxes = redactBoxes[pgNum];
        if (!boxes || !boxes.length) continue;
        const pdfPage = await redactPdfJsDoc.getPage(pgNum);
        const viewport = pdfPage.getViewport({ scale: 1.5 });
        const { width: pdfW, height: pdfH } = pdfPages[pgNum-1].getSize();
        const scaleX = pdfW / viewport.width;
        const scaleY = pdfH / viewport.height;
        for (const b of boxes) {
          const rx = b.x * scaleX;
          const rw = Math.abs(b.w) * scaleX;
          const rh = Math.abs(b.h) * scaleY;
          const ry = pdfH - (b.y * scaleY) - rh;
          pdfPages[pgNum-1].drawRectangle({ x: rx, y: ry, width: rw, height: rh, color: rgb(0,0,0) });
        }
      }
      const out = await redactPdfDoc.save();
      const fname = document.getElementById('redact-file').files[0]?.name || 'redacted.pdf';
      triggerDownload(new Blob([out], {type:'application/pdf'}), fname.replace(/.pdf$/i,'') + '-redacted.pdf');
      Stats.inc(0);
      showResult(resultEl, 'success', 'Redactions applied permanently! Download started.');
    } catch(e) { showResult(resultEl, 'error', 'Error: ' + e.message); }
    finally { btn.innerHTML = 'Apply Redactions and Save'; btn.disabled = false; }
  });
}

// ═══════════════════════════════════════════════════════
// BATCH COMPRESS
{
  let batchFiles = [];
  setupDrop(document.getElementById('batch-drop'), document.getElementById('batch-file'), files => addBatchFiles([...files]));
  document.getElementById('batch-file') && document.getElementById('batch-file').addEventListener('change', function() { addBatchFiles([...this.files]); });

  function addBatchFiles(files) {
    files.forEach(f => { if (!batchFiles.find(x => x.name === f.name)) batchFiles.push(f); });
    renderBatchList();
  }
  function renderBatchList() {
    const el = document.getElementById('batch-file-list');
    el.innerHTML = '';
    batchFiles.forEach((f, i) => {
      el.appendChild(renderFileItem(f, () => { batchFiles.splice(i, 1); renderBatchList(); }));
    });
  }
  document.getElementById('batch-apply-btn') && document.getElementById('batch-apply-btn').addEventListener('click', async () => {
    if (!batchFiles.length) return toast('Please add PDF files', 'error');
    const btn = document.getElementById('batch-apply-btn');
    const resultEl = document.getElementById('batch-result');
    const progressEl = document.getElementById('batch-progress');
    const barEl = document.getElementById('batch-bar');
    const statusEl = document.getElementById('batch-status');
    btn.innerHTML = '<span class="inline-spinner"></span> Compressing...'; btn.disabled = true;
    progressEl.style.display = 'block';
    showResult(resultEl, 'info', 'Starting batch compression...'); resultEl.style.display = 'block';
    try {
      const { PDFDocument } = await loadPdfLib();
      const zipPass = document.getElementById('batch-zip-pass').value.trim();
      const renamePat = (document.getElementById('batch-rename').value || '{name}-compressed').trim();
      const todayStr = new Date().toISOString().slice(0, 10);
      const collectedFiles = [];
      let totalSaved = 0;
      for (let i = 0; i < batchFiles.length; i++) {
        const f = batchFiles[i];
        statusEl.textContent = 'Compressing ' + f.name + '... (' + (i+1) + '/' + batchFiles.length + ')';
        barEl.style.width = ((i / batchFiles.length) * 85) + '%';
        const ab = await f.arrayBuffer();
        const pdfDoc = await PDFDocument.load(ab, { ignoreEncryption: true });
        const out = await pdfDoc.save({ useObjectStreams: true });
        totalSaved += ab.byteLength - out.byteLength;
        const fname = renamePat.replace('{name}', f.name.replace(/\.pdf$/i, '')).replace('{date}', todayStr).replace('{i}', String(i + 1)) + '.pdf';
        collectedFiles.push({ name: fname, data: out });
      }
      barEl.style.width = '92%';
      statusEl.textContent = 'Creating ZIP archive' + (zipPass ? ' (encrypting...)' : '...');
      let zipBlob;
      if (zipPass) {
        if (!window.zip) {
          await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.32/dist/zip.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
        }
        const zipWrt = new window.zip.ZipWriter(new window.zip.BlobWriter('application/zip'), { password: zipPass, encryptionStrength: 3 });
        for (const cf of collectedFiles) {
          await zipWrt.add(cf.name, new window.zip.BlobReader(new Blob([cf.data], { type: 'application/pdf' })));
        }
        zipBlob = await zipWrt.close();
      } else {
        if (!window.JSZip) {
          await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
        }
        const zip = new window.JSZip();
        for (const cf of collectedFiles) { zip.file(cf.name, cf.data); }
        zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      }
      barEl.style.width = '100%';
      triggerDownload(zipBlob, 'compressed-pdfs.zip');
      Stats.inc(batchFiles.reduce((s,f) => s + f.size,0) / 1048576);
      const savedStr = totalSaved > 0 ? fmtSize(totalSaved) + ' saved' : 'already optimized';
      const pwdNote = zipPass ? ' (AES-256 encrypted)' : '';
      showResult(resultEl, 'success', batchFiles.length + ' PDFs compressed (' + savedStr + ')! Download started.' + pwdNote);
    } catch(e) { showResult(resultEl, 'error', 'Error: ' + e.message); }
    finally { btn.innerHTML = 'Compress All and Download ZIP'; btn.disabled = false; progressEl.style.display = 'none'; }
  });
}


// PDF DIFF VIEWER
{
  let diffA = null, diffB = null, diffPdfA = null, diffPdfB = null, diffPageIdx = 0, diffPageCount = 0;
  const diffAListEl = document.getElementById('diff-list-a'), diffBListEl = document.getElementById('diff-list-b');
  const diffOptsEl = document.getElementById('diff-options'), diffViewerEl = document.getElementById('diff-viewer');
  const diffCanvA = document.getElementById('diff-canvas-a'), diffCanvB = document.getElementById('diff-canvas-b'), diffCanvDiff = document.getElementById('diff-canvas-diff');
  const diffPageInfo = document.getElementById('diff-page-info'), diffSummary = document.getElementById('diff-summary');

  function diffCheckBoth() { if (diffA && diffB) diffOptsEl.style.display = 'block'; }
  function diffOnRemoveA() { diffA = null; diffAListEl.innerHTML = ''; diffOptsEl.style.display = 'none'; diffViewerEl.style.display = 'none'; }
  function diffOnRemoveB() { diffB = null; diffBListEl.innerHTML = ''; diffOptsEl.style.display = 'none'; diffViewerEl.style.display = 'none'; }

  setupDrop(document.getElementById('diff-drop-a'), document.getElementById('diff-file-a'), function(f) {
    diffA = f[0]; diffAListEl.innerHTML = ''; diffAListEl.appendChild(renderFileItem(diffA, diffOnRemoveA)); diffCheckBoth();
  });
  setupDrop(document.getElementById('diff-drop-b'), document.getElementById('diff-file-b'), function(f) {
    diffB = f[0]; diffBListEl.innerHTML = ''; diffBListEl.appendChild(renderFileItem(diffB, diffOnRemoveB)); diffCheckBoth();
  });
  document.getElementById('diff-file-a').addEventListener('change', function() {
    if (this.files[0]) { diffA = this.files[0]; diffAListEl.innerHTML = ''; diffAListEl.appendChild(renderFileItem(diffA, diffOnRemoveA)); diffCheckBoth(); }
  });
  document.getElementById('diff-file-b').addEventListener('change', function() {
    if (this.files[0]) { diffB = this.files[0]; diffBListEl.innerHTML = ''; diffBListEl.appendChild(renderFileItem(diffB, diffOnRemoveB)); diffCheckBoth(); }
  });

  async function renderDiffPage(idx) {
    diffPageIdx = idx;
    var scale = 1.0;
    var pA = await diffPdfA.getPage(idx + 1);
    var vpA = pA.getViewport({ scale: scale });
    diffCanvA.width = vpA.width; diffCanvA.height = vpA.height;
    var ctxA = diffCanvA.getContext('2d');
    ctxA.fillStyle = '#ffffff'; ctxA.fillRect(0, 0, vpA.width, vpA.height);
    await pA.render({ canvasContext: ctxA, viewport: vpA }).promise;

    var changed = 0, total = 0;
    if (idx < diffPdfB.numPages) {
      var pB = await diffPdfB.getPage(idx + 1);
      var vpB = pB.getViewport({ scale: scale });
      diffCanvB.width = vpB.width; diffCanvB.height = vpB.height;
      var ctxB = diffCanvB.getContext('2d');
      ctxB.fillStyle = '#ffffff'; ctxB.fillRect(0, 0, vpB.width, vpB.height);
      await pB.render({ canvasContext: ctxB, viewport: vpB }).promise;
      var w = Math.min(diffCanvA.width, diffCanvB.width);
      var h = Math.min(diffCanvA.height, diffCanvB.height);
      diffCanvDiff.width = w; diffCanvDiff.height = h;
      var ctxD = diffCanvDiff.getContext('2d');
      ctxD.fillStyle = '#ffffff'; ctxD.fillRect(0, 0, w, h);
      var dA = ctxA.getImageData(0, 0, w, h).data;
      var dB = ctxB.getImageData(0, 0, w, h).data;
      var outImg = ctxD.createImageData(w, h);
      total = w * h;
      for (var p = 0; p < dA.length; p += 4) {
        var diff = Math.abs(dA[p] - dB[p]) + Math.abs(dA[p+1] - dB[p+1]) + Math.abs(dA[p+2] - dB[p+2]);
        if (diff > 30) {
          outImg.data[p] = 220; outImg.data[p+1] = 38; outImg.data[p+2] = 38; outImg.data[p+3] = 220;
          changed++;
        } else {
          outImg.data[p] = dA[p]; outImg.data[p+1] = dA[p+1]; outImg.data[p+2] = dA[p+2]; outImg.data[p+3] = 60;
        }
      }
      ctxD.putImageData(outImg, 0, 0);
    } else {
      diffCanvB.width = diffCanvA.width; diffCanvB.height = diffCanvA.height;
      diffCanvDiff.width = diffCanvA.width; diffCanvDiff.height = diffCanvA.height;
      var ctxB2 = diffCanvB.getContext('2d'); ctxB2.fillStyle = '#1e293b'; ctxB2.fillRect(0, 0, diffCanvB.width, diffCanvB.height);
      ctxB2.fillStyle = '#94a3b8'; ctxB2.font = '14px sans-serif'; ctxB2.textAlign = 'center'; ctxB2.fillText('(page not in revised PDF)', diffCanvB.width / 2, diffCanvB.height / 2);
      var ctxD2 = diffCanvDiff.getContext('2d'); ctxD2.fillStyle = '#dc2626'; ctxD2.fillRect(0, 0, diffCanvDiff.width, diffCanvDiff.height);
      total = 1; changed = 1;
    }

    diffPageInfo.textContent = 'Page ' + (idx + 1) + ' / ' + diffPageCount;
    var pct = total > 0 ? Math.round(changed / total * 100) : 0;
    diffSummary.textContent = pct + '% of pixels changed';
    diffSummary.style.color = pct > 10 ? 'var(--red)' : pct > 1 ? 'var(--yellow)' : 'var(--green)';
    document.getElementById('diff-prev').disabled = idx === 0;
    document.getElementById('diff-next').disabled = idx >= diffPageCount - 1;
  }

  document.getElementById('diff-run').addEventListener('click', async function() {
    if (!diffA || !diffB) return toast('Select both PDFs', 'error');
    var btn = document.getElementById('diff-run');
    btn.disabled = true; btn.innerHTML = '<span class="inline-spinner"></span> Comparing...';
    try {
      var pdfjsLib = await loadPdfjsLib();
      diffPdfA = await pdfjsLib.getDocument({ data: await diffA.arrayBuffer() }).promise;
      diffPdfB = await pdfjsLib.getDocument({ data: await diffB.arrayBuffer() }).promise;
      diffPageCount = Math.max(diffPdfA.numPages, diffPdfB.numPages);
      diffViewerEl.style.display = 'block';
      await renderDiffPage(0);
      toast('Comparison ready - ' + diffPageCount + ' page' + (diffPageCount !== 1 ? 's' : ''));
    } catch(e) { toast('Error: ' + e.message, 'error'); }
    btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Compare PDFs';
  });

  document.getElementById('diff-prev').addEventListener('click', async function() {
    if (diffPageIdx > 0) await renderDiffPage(diffPageIdx - 1);
  });
  document.getElementById('diff-next').addEventListener('click', async function() {
    if (diffPageIdx < diffPageCount - 1) await renderDiffPage(diffPageIdx + 1);
  });

  document.getElementById('diff-clear').addEventListener('click', function() {
    diffA = null; diffB = null; diffPdfA = null; diffPdfB = null;
    diffAListEl.innerHTML = ''; diffBListEl.innerHTML = '';
    diffOptsEl.style.display = 'none'; diffViewerEl.style.display = 'none';
    document.getElementById('diff-file-a').value = '';
    document.getElementById('diff-file-b').value = '';
  });
}
// GLOBAL COPY BUTTONS
document.addEventListener('click',e=>{
  const btn=e.target.closest('.copy-btn');if(!btn)return;
  const text=btn.dataset.copy||btn.closest('.code-pill')?.querySelector('span')?.textContent;
  if(!text)return;
  navigator.clipboard.writeText(text).then(()=>{btn.style.color='var(--green)';setTimeout(()=>btn.style.color='',1500);toast('Copied!');});
});

// ── RECENT FILES ──
var NyxRecents = (function(){
  var KEY = "nyx_recents_v1";
  var TOOL_LABELS = {
    split:"Split",merge:"Merge",compress:"Compress",watermark:"Watermark",protect:"Protect",
    extract:"Extract",ocr:"OCR",rotate:"Rotate",editpdf:"Edit",convert:"Convert",sign:"Sign",signrequest:"Sign Request",
    annotate:"Annotate",pagemanager:"Pages",number:"Number",redact:"Redact",batch:"Batch",
    aisplit:"AI Split",alerts:"Alerts",distribution:"Distribution",pdf2qr:"QR Stamp"
  };
  function get(){ try{ return JSON.parse(localStorage.getItem(KEY))||[]; }catch(e){ return []; } }
  function add(name, tool, sizeBytes){
    var arr = get();
    arr.unshift({name:name, tool:tool||"unknown", size:sizeBytes||0, date:Date.now()});
    arr = arr.slice(0,10);
    try{ localStorage.setItem(KEY, JSON.stringify(arr)); }catch(e){}
    render();
  }
  function fmtDate(ts){
    var d = new Date(ts);
    return d.toLocaleDateString(undefined,{month:"short",day:"numeric"})+" "+d.toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit"});
  }
  function fmtSize(b){
    if(!b||b===0) return "";
    if(b<1024) return b+" B";
    if(b<1048576) return (b/1024).toFixed(0)+" KB";
    return (b/1048576).toFixed(1)+" MB";
  }
  function render(){
    var el = document.getElementById("recent-files-list"); if(!el) return;
    var items = get();
    if(!items.length){ el.innerHTML = "<p style=\"color:var(--muted);font-size:.82rem;padding:.35rem 0\">No files processed yet - download a result to see it here.</p>"; return; }
    el.innerHTML = "";
    items.forEach(function(it){
      var row = document.createElement("div");
      row.className = "recent-file-row";
      row.title = "Go to " + (TOOL_LABELS[it.tool]||it.tool) + " tool";
      var svg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
      var sz = fmtSize(it.size);
      var meta = fmtDate(it.date) + (sz ? " · "+sz : "");
      var badge = TOOL_LABELS[it.tool] || it.tool;
      row.innerHTML = svg +
        '<span class="recent-fname">' + it.name + '</span>' +
        '<span class="recent-tool-badge">' + badge + '</span>' +
        '<span class="recent-meta">' + meta + '</span>';
      row.addEventListener("click", function(){ if(typeof switchPanel==="function") switchPanel(it.tool); });
      el.appendChild(row);
    });
  }
  function clear(){ try{ localStorage.removeItem(KEY); }catch(e){} render(); }
  return {add:add, get:get, render:render, clear:clear};
})();

// Wire clear button
var _rclearBtn = document.getElementById("recent-clear-btn");
if(_rclearBtn) _rclearBtn.addEventListener("click", function(){ NyxRecents.clear(); });

// Render on home panel activation
document.addEventListener("nyx:panel-changed", function(e){ if(e.detail==="home") NyxRecents.render(); });
NyxRecents.render();

// Wrap triggerDownload to record recent file + fire confetti
(function(){
  var _lastConfetti = 0;
  function _loadConfetti() {
    if (window.confetti) return Promise.resolve();
    return new Promise(function(res) {
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js";
      s.onload = res; document.head.appendChild(s);
    });
  }
  document.addEventListener('nyx:download', function(e){
    var blob = e.detail.blob, name = e.detail.filename;
    NyxRecents.add(name, window.__nyxCurrentPanel||"unknown", blob ? blob.size : 0);
    var now = Date.now();
    if (now - _lastConfetti > 2500) {
      _lastConfetti = now;
      _loadConfetti().then(function() {
        if (!window.confetti) return;
        window.confetti({ particleCount: 70, spread: 65, origin: { y: 0.72 },
          colors: ["#7c3aed","#a78bfa","#34d399","#60a5fa","#fbbf24"] });
      });
    }
  });
})();

// Mobile sidebar toggle
{
  var _ham=document.getElementById('hamburger-btn');
  var _sidebarEl=document.querySelector('aside.sidebar');
  var _overlayEl=document.getElementById('sidebar-overlay');
  function _closeSidebar(){if(_sidebarEl)_sidebarEl.classList.remove('open');if(_overlayEl)_overlayEl.classList.remove('open');}
  function _toggleSidebar(){if(!_sidebarEl)return;var open=_sidebarEl.classList.contains('open');_sidebarEl.classList.toggle('open',!open);if(_overlayEl)_overlayEl.classList.toggle('open',!open);}
  if(_ham)_ham.addEventListener('click',_toggleSidebar);
  if(_overlayEl)_overlayEl.addEventListener('click',_closeSidebar);
  document.querySelectorAll('.nav-item').forEach(function(btn){btn.addEventListener('click',function(){if(window.innerWidth<=760)_closeSidebar();});});
}

// ── KEYBOARD SHORTCUTS ──
document.addEventListener("keydown", function(e){
  var tag = document.activeElement ? document.activeElement.tagName : "";
  var inInput = (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || document.activeElement.isContentEditable);
  // Escape: close upgrade modal, shortcuts modal, cmd palette, then sidebar
  if(e.key === "Escape"){
    var modal = document.getElementById("upgrade-modal");
    if(modal && modal.style.display !== "none" && modal.style.display !== ""){
      modal.style.display = "none"; return;
    }
    var shortcutsOv = document.getElementById("shortcuts-overlay");
    if(shortcutsOv && shortcutsOv.style.display !== "none" && shortcutsOv.style.display !== ""){
      shortcutsOv.style.display = "none"; return;
    }
    var cmdOv = document.getElementById("cmd-overlay");
    if(cmdOv && cmdOv.style.display !== "none" && cmdOv.style.display !== ""){
      nyxCmdClose(); return;
    }
    if(typeof _closeSidebar === "function") _closeSidebar();
    return;
  }
  // Skip all other shortcuts if typing in a form field
  if(inInput) return;
  // D - toggle dark/light theme
  if(e.key === "d" || e.key === "D"){
    var tb = document.getElementById("theme-toggle");
    if(tb) tb.click();
    return;
  }
  // H - go home
  if(e.key === "h" || e.key === "H"){
    if(typeof switchPanel === "function") switchPanel("home");
    return;
  }
  // ? - show shortcuts modal
  if(e.key === "?"){
    document.getElementById("shortcuts-overlay").style.display = "flex";
    return;
  }
  // Ctrl+K / Cmd+K - command palette
  if((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")){
    e.preventDefault();
    nyxCmdOpen();
    return;
  }
});


// ── COMMAND PALETTE ──
(function(){
  var CMDS = [
    {panel:"split",label:"Split PDF",desc:"Extract pages or split by range or every N pages"},
    {panel:"aisplit",label:"AI Smart Split",desc:"Describe how to split - Claude plans it for you"},
    {panel:"merge",label:"Merge PDFs",desc:"Combine multiple PDFs into one document"},
    {panel:"compress",label:"Compress PDF",desc:"Reduce file size using object stream compression"},
    {panel:"watermark",label:"Watermark PDF",desc:"Stamp diagonal text across every page"},
    {panel:"protect",label:"Protect PDF",desc:"Add password protection and access controls"},
    {panel:"extract",label:"Extract Pages",desc:"Pull specific pages out as a new PDF"},
    {panel:"ocr",label:"OCR Text Extraction",desc:"Extract text from scanned / image PDFs"},
    {panel:"rotate",label:"Rotate Pages",desc:"Rotate specific pages or the entire document"},
    {panel:"editpdf",label:"Edit PDF",desc:"Add text overlays, images, and annotations"},
    {panel:"convert",label:"Convert",desc:"PDF to images, images to PDF, searchable PDF, QR stamp"},
    {panel:"sign",label:"Sign PDF",desc:"Draw or type a handwritten signature"},
    {panel:"signrequest",label:"Request Signatures",desc:"Prepare signer fields and save a signature request draft"},
    {panel:"annotate",label:"Annotate PDF",desc:"Highlight, underline, and add comments"},
    {panel:"pagemanager",label:"Page Manager",desc:"Drag-and-drop page reordering and deletion"},
    {panel:"number",label:"Page Numbers",desc:"Stamp page numbers onto every page"},
    {panel:"redact",label:"Redact PDF",desc:"Permanently black out sensitive text"},
    {panel:"batch",label:"Batch Compress",desc:"Compress many PDFs at once with rename templates"},
    {panel:"diff",label:"PDF Diff Viewer",desc:"Compare two PDFs - pixel differences shown in red"},
    {panel:"alerts",label:"Alerts",desc:"Review signature expirations and document follow-up"},
    {panel:"distribution",label:"Distribute Documents",desc:"Send PDF versions to individual or bulk recipients"},
    {panel:"apikeys",label:"API Keys",desc:"Manage programmatic API access"},
    {panel:"account",label:"Account Settings",desc:"Profile, subscription, and billing"},
    {panel:"home",label:"Home",desc:"Dashboard overview and recent files"},
  ];

  var overlay = document.getElementById("cmd-overlay");
  var input = document.getElementById("cmd-input");
  var results = document.getElementById("cmd-results");
  var activeIdx = 0;

  function highlight(q, text) {
    if (!q) return text;
    var idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return text;
    return text.slice(0, idx) + '<mark style="background:rgba(124,58,237,.35);color:inherit;border-radius:2px">' + text.slice(idx, idx + q.length) + '</mark>' + text.slice(idx + q.length);
  }

  function render(q) {
    var filtered = q ? CMDS.filter(function(c) {
      return c.label.toLowerCase().indexOf(q.toLowerCase()) !== -1 ||
             c.desc.toLowerCase().indexOf(q.toLowerCase()) !== -1;
    }) : CMDS;
    results.innerHTML = "";
    if (!filtered.length) { results.innerHTML = '<div class="cmd-empty">No tools found</div>'; return; }
    filtered.forEach(function(c, i) {
      var item = document.createElement("div");
      item.className = "cmd-item" + (i === 0 ? " cmd-active" : "");
      item.dataset.panel = c.panel;
      item.innerHTML = '<div class="cmd-item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>' +
        '<div><div class="cmd-item-label">' + highlight(q, c.label) + '</div><div class="cmd-item-desc">' + c.desc + '</div></div>';
      item.addEventListener("click", function() { nyxCmdClose(); switchPanel(c.panel); });
      item.addEventListener("mouseover", function() {
        results.querySelectorAll(".cmd-item").forEach(function(el) { el.classList.remove("cmd-active"); });
        item.classList.add("cmd-active");
        activeIdx = i;
      });
      results.appendChild(item);
    });
    activeIdx = 0;
    window._nyxCmdFiltered = filtered;
  }

  window.nyxCmdOpen = function() {
    overlay.style.display = "flex";
    input.value = "";
    render("");
    setTimeout(function() { input.focus(); }, 30);
  };
  window.nyxCmdClose = function() {
    overlay.style.display = "none";
    input.value = "";
  };

  input.addEventListener("input", function() { render(input.value.trim()); });

  input.addEventListener("keydown", function(e) {
    var items = results.querySelectorAll(".cmd-item");
    if (!items.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[activeIdx].classList.remove("cmd-active");
      activeIdx = (activeIdx + 1) % items.length;
      items[activeIdx].classList.add("cmd-active");
      items[activeIdx].scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[activeIdx].classList.remove("cmd-active");
      activeIdx = (activeIdx - 1 + items.length) % items.length;
      items[activeIdx].classList.add("cmd-active");
      items[activeIdx].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      var filtered = window._nyxCmdFiltered || CMDS;
      if (filtered[activeIdx]) { nyxCmdClose(); switchPanel(filtered[activeIdx].panel); }
    }
  });

  overlay.addEventListener("click", function(e) { if (e.target === overlay) nyxCmdClose(); });

  // Shortcuts modal close button
  var scBtn = document.getElementById("shortcuts-close");
  var scOv = document.getElementById("shortcuts-overlay");
  if (scBtn) scBtn.addEventListener("click", function() { scOv.style.display = "none"; });
  if (scOv) scOv.addEventListener("click", function(e) { if (e.target === scOv) scOv.style.display = "none"; });
})();

// ── PASSWORD VISIBILITY TOGGLES ──
document.addEventListener("click", function(e) {
  var btn = e.target.closest(".pw-toggle");
  if (!btn) return;
  var input = btn.parentElement.querySelector("input");
  var show = input.type === "password";
  input.type = show ? "text" : "password";
  btn.classList.toggle("showing", show);
  btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
});

// ── SIDEBAR SEARCH FILTER ──
(function(){
  var inp = document.getElementById("sidebar-search");
  if (!inp) return;
  function applyFilter() {
    var q = inp.value.trim().toLowerCase();
    var sections = document.querySelectorAll(".sidebar-section");
    var items = document.querySelectorAll(".nav-item[data-panel]");
    items.forEach(function(btn) {
      var label = btn.textContent.trim().toLowerCase();
      btn.style.display = (!q || label.indexOf(q) !== -1) ? "" : "none";
    });
    sections.forEach(function(sec) {
      var next = sec.nextElementSibling;
      var hasVisible = false;
      while (next && !next.classList.contains("sidebar-section")) {
        if (next.tagName === "BUTTON" && next.style.display !== "none") hasVisible = true;
        next = next.nextElementSibling;
      }
      sec.style.display = hasVisible ? "" : "none";
    });
  }
  inp.addEventListener("input", applyFilter);
  // Password managers ignore autocomplete=off; keep the field readonly until the user interacts.
  function unlock(){ inp.removeAttribute("readonly"); }
  inp.addEventListener("focus", unlock);
  inp.addEventListener("pointerdown", unlock);
  inp.addEventListener("touchstart", unlock, { passive: true });
  function clearAutofill() { if (inp.value && inp !== document.activeElement) { inp.value = ""; applyFilter(); } }
  var sweeps = 0;
  var sweep = setInterval(function(){ clearAutofill(); if (++sweeps >= 12) clearInterval(sweep); }, 500);
  window.addEventListener("pageshow", clearAutofill);
})();

// ── CLIPBOARD PASTE TO DROP ZONES ──
document.addEventListener("paste", function(e) {
  var items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  var pdfFile = null;
  for (var i = 0; i < items.length; i++) {
    if (items[i].kind === "file" && items[i].type === "application/pdf") {
      pdfFile = items[i].getAsFile(); break;
    }
  }
  if (!pdfFile) return;
  var panel = document.querySelector(".panel.active");
  if (!panel) return;
  var inp2 = panel.querySelector("input[type=file][accept='.pdf']");
  if (!inp2) return;
  try {
    var dt = new DataTransfer();
    dt.items.add(pdfFile);
    inp2.files = dt.files;
    inp2.dispatchEvent(new Event("change", { bubbles: true }));
    toast("PDF pasted from clipboard", "success");
  } catch(e2) {}
});

// ── PDF METADATA PANEL ──
(function(){
  var metaFile = null;
  var dropEl2 = document.getElementById("meta-drop");
  var fileIn2 = document.getElementById("meta-file");
  var editorEl = document.getElementById("meta-editor");
  var saveBtn2 = document.getElementById("meta-save-btn");
  var resultEl2 = document.getElementById("meta-result");

  function loadMeta(file) {
    metaFile = file;
    loadPdfLib().then(function(PDFLib) {
      return file.arrayBuffer().then(function(ab) {
        return PDFLib.PDFDocument.load(ab, { ignoreEncryption: true });
      }).then(function(pdfDoc) {
        function safeGet(fn) { try { return fn() || ""; } catch(e) { return ""; } }
        document.getElementById("meta-title").value = safeGet(function(){ return pdfDoc.getTitle(); });
        document.getElementById("meta-author").value = safeGet(function(){ return pdfDoc.getAuthor(); });
        document.getElementById("meta-subject").value = safeGet(function(){ return pdfDoc.getSubject(); });
        document.getElementById("meta-keywords").value = safeGet(function(){ return pdfDoc.getKeywords(); });
        document.getElementById("meta-creator").value = safeGet(function(){ return pdfDoc.getCreator(); });
        document.getElementById("meta-created").value = safeGet(function(){
          var d = pdfDoc.getCreationDate(); return d ? d.toLocaleString() : "(unknown)";
        });
        document.getElementById("meta-modified").value = safeGet(function(){
          var d = pdfDoc.getModificationDate(); return d ? d.toLocaleString() : "(unknown)";
        });
        document.getElementById("meta-pages").value = pdfDoc.getPageCount() + " pages";
        document.getElementById("meta-filesize").value = fmtSize(file.size);
        editorEl.style.display = "";
        window.__nyxMetaDoc = pdfDoc;
      });
    }).catch(function(err) {
      showResult(resultEl2, "error", "Could not read PDF: " + (err.message || err));
    });
  }

  if (dropEl2) {
    dropEl2.addEventListener("dragover", function(e) { e.preventDefault(); dropEl2.classList.add("drag-over"); });
    dropEl2.addEventListener("dragleave", function() { dropEl2.classList.remove("drag-over"); });
    dropEl2.addEventListener("drop", function(e) {
      e.preventDefault(); dropEl2.classList.remove("drag-over");
      var files = Array.from(e.dataTransfer.files).filter(function(f) { return f.name.toLowerCase().endsWith(".pdf"); });
      if (files.length) loadMeta(files[0]);
    });
    dropEl2.addEventListener("click", function() { if(fileIn2) fileIn2.click(); });
  }
  if (fileIn2) fileIn2.addEventListener("change", function() { if (fileIn2.files[0]) loadMeta(fileIn2.files[0]); });

  if (saveBtn2) saveBtn2.addEventListener("click", function() {
    if (!window.__nyxMetaDoc || !metaFile) return;
    var doc = window.__nyxMetaDoc;
    try {
      doc.setTitle(document.getElementById("meta-title").value);
      doc.setAuthor(document.getElementById("meta-author").value);
      doc.setSubject(document.getElementById("meta-subject").value);
      doc.setKeywords([document.getElementById("meta-keywords").value]);
      doc.setCreator(document.getElementById("meta-creator").value);
      doc.setModificationDate(new Date());
      doc.save().then(function(bytes) {
        var blob = new Blob([bytes], { type: "application/pdf" });
        var outName = metaFile.name.replace(/\.pdf$/i, "") + "-meta.pdf";
        triggerDownload(blob, outName);
        showResult(resultEl2, "success", "Saved - downloading " + outName);
      }).catch(function(err) {
        showResult(resultEl2, "error", "Save failed: " + (err.message || err));
      });
    } catch(e2) {
      showResult(resultEl2, "error", "Error: " + (e2.message || e2));
    }
  });
})();

// ── HEADER & FOOTER ──
(function(){
  var hfFile=null;
  var dropEl=document.getElementById("hf-drop");
  var fileIn=document.getElementById("hf-file");
  var fileList=document.getElementById("hf-file-list");
  var options=document.getElementById("hf-options");
  var resultEl=document.getElementById("hf-result");
  function setFile(f){hfFile=f;fileList.innerHTML="";fileList.appendChild(renderFileItem(f,function(){hfFile=null;options.style.display="none";fileList.innerHTML="";}));options.style.display="";}
  if(dropEl){
    dropEl.addEventListener("dragover",function(e){e.preventDefault();dropEl.classList.add("drag-over");});
    dropEl.addEventListener("dragleave",function(){dropEl.classList.remove("drag-over");});
    dropEl.addEventListener("drop",function(e){e.preventDefault();dropEl.classList.remove("drag-over");var fl=Array.from(e.dataTransfer.files).filter(function(f){return f.name.toLowerCase().endsWith(".pdf");});if(fl.length)setFile(fl[0]);});
    dropEl.addEventListener("click",function(){if(fileIn)fileIn.click();});
  }
  if(fileIn)fileIn.addEventListener("change",function(){if(fileIn.files[0])setFile(fileIn.files[0]);});
  document.getElementById("hf-run").addEventListener("click",async function(){
    if(!hfFile)return;
    var hText=document.getElementById("hf-header").value.trim();
    var fText=document.getElementById("hf-footer").value.trim();
    if(!hText&&!fText){showResult(resultEl,"error","Enter header or footer text");return;}
    var hSz=parseFloat(document.getElementById("hf-header-size").value)||11;
    var fSz=parseFloat(document.getElementById("hf-footer-size").value)||10;
    var hMg=parseFloat(document.getElementById("hf-header-margin").value)||20;
    var fMg=parseFloat(document.getElementById("hf-footer-margin").value)||18;
    var btn=this;btn.disabled=true;
    showResult(resultEl,"info","Applying…");
    try{
      var PDFLib=await loadPdfLib();
      var ab=await hfFile.arrayBuffer();
      var doc=await PDFLib.PDFDocument.load(ab);
      var font=await doc.embedFont(PDFLib.StandardFonts.Helvetica);
      var pages=doc.getPages();var total=pages.length;
      pages.forEach(function(page,i){
        var sz=page.getSize();var pw=sz.width;var ph=sz.height;var pn=String(i+1);
        if(hText){var ht=hText.replace("{page}",pn).replace("{total}",String(total));page.drawText(ht,{x:hMg,y:ph-hMg-hSz,font:font,size:hSz,color:PDFLib.rgb(0.2,0.2,0.2)});}
        if(fText){var ft=fText.replace("{page}",pn).replace("{total}",String(total));page.drawText(ft,{x:fMg,y:fMg,font:font,size:fSz,color:PDFLib.rgb(0.2,0.2,0.2)});}
      });
      var bytes=await doc.save();
      var blob=new Blob([bytes],{type:"application/pdf"});
      var outName=hfFile.name.replace(/\.pdf$/i,"")+"-stamped.pdf";
      triggerDownload(blob,outName);
      showResult(resultEl,"success","Applied to "+total+" page"+(total>1?"s":"")+" - downloading "+outName);
    }catch(err){showResult(resultEl,"error","Error: "+(err.message||err));}
    btn.disabled=false;
  });
  document.getElementById("hf-clear").addEventListener("click",function(){hfFile=null;fileList.innerHTML="";options.style.display="none";resultEl.className="result-box";});
})();

// ── FLATTEN PDF ──
(function(){
  var flFile=null;
  var dropEl=document.getElementById("fl-drop");
  var fileIn=document.getElementById("fl-file");
  var fileList=document.getElementById("fl-file-list");
  var options=document.getElementById("fl-options");
  var resultEl=document.getElementById("fl-result");
  function setFile(f){flFile=f;fileList.innerHTML="";fileList.appendChild(renderFileItem(f,function(){flFile=null;options.style.display="none";fileList.innerHTML="";}));options.style.display="";}
  if(dropEl){
    dropEl.addEventListener("dragover",function(e){e.preventDefault();dropEl.classList.add("drag-over");});
    dropEl.addEventListener("dragleave",function(){dropEl.classList.remove("drag-over");});
    dropEl.addEventListener("drop",function(e){e.preventDefault();dropEl.classList.remove("drag-over");var fl=Array.from(e.dataTransfer.files).filter(function(f){return f.name.toLowerCase().endsWith(".pdf");});if(fl.length)setFile(fl[0]);});
    dropEl.addEventListener("click",function(){if(fileIn)fileIn.click();});
  }
  if(fileIn)fileIn.addEventListener("change",function(){if(fileIn.files[0])setFile(fileIn.files[0]);});
  document.getElementById("fl-run").addEventListener("click",async function(){
    if(!flFile)return;
    var doForms=document.getElementById("fl-forms").checked;
    var btn=this;btn.disabled=true;
    showResult(resultEl,"info","Processing…");
    try{
      var PDFLib=await loadPdfLib();
      var ab=await flFile.arrayBuffer();
      var doc=await PDFLib.PDFDocument.load(ab,{ignoreEncryption:true});
      if(doForms){try{doc.getForm().flatten();}catch(fe){}}
      var bytes=await doc.save();
      var blob=new Blob([bytes],{type:"application/pdf"});
      var outName=flFile.name.replace(/\.pdf$/i,"")+"-flat.pdf";
      triggerDownload(blob,outName);
      showResult(resultEl,"success","Done - downloading "+outName);
    }catch(err){showResult(resultEl,"error","Error: "+(err.message||err));}
    btn.disabled=false;
  });
  document.getElementById("fl-clear").addEventListener("click",function(){flFile=null;fileList.innerHTML="";options.style.display="none";resultEl.className="result-box";});
})();
// ── BEFOREUNLOAD WARNING ──
window.addEventListener("beforeunload", function(e){
  var hasWork = Array.from(document.querySelectorAll("input[type=file]")).some(function(inp){
    return inp.files && inp.files.length > 0;
  });
  if(hasWork){
    e.preventDefault();
    e.returnValue = "";
  }
});
if('launchQueue' in window){
  window.launchQueue.setConsumer(async launchParams=>{
    const files=[];
    for(const handle of launchParams.files||[]){
      try{files.push(await handle.getFile());}catch(_error){}
    }
    window.__nyxLaunchFiles.push(...files);
    await window.__nyxProcessLaunchFiles();
  });
}
// ── PRODUCT ASSISTANT ──
const nyxChatLauncher=document.getElementById('nyx-chat-launcher'),nyxChatPanel=document.getElementById('nyx-chat-panel'),nyxChatClose=document.getElementById('nyx-chat-close'),nyxChatForm=document.getElementById('nyx-chat-form'),nyxChatInput=document.getElementById('nyx-chat-input'),nyxChatSend=document.getElementById('nyx-chat-send'),nyxChatMessages=document.getElementById('nyx-chat-messages'),nyxChatHistory=[];
function setNyxChatOpen(open){nyxChatPanel.hidden=!open;nyxChatLauncher.setAttribute('aria-expanded',String(open));if(open)nyxChatInput.focus();}function addNyxChatMessage(role,content,isError=false){const message=document.createElement('p');message.className=`nyx-chat-message ${role}${isError?' error':''}`;message.textContent=content;nyxChatMessages.append(message);nyxChatMessages.scrollTop=nyxChatMessages.scrollHeight;return message;}
nyxChatLauncher.addEventListener('click',()=>setNyxChatOpen(nyxChatPanel.hidden));nyxChatClose.addEventListener('click',()=>setNyxChatOpen(false));nyxChatForm.addEventListener('submit',async event=>{event.preventDefault();const content=nyxChatInput.value.trim();if(!content)return;nyxChatHistory.push({role:'user',content});addNyxChatMessage('user',content);nyxChatInput.value='';nyxChatInput.disabled=true;nyxChatSend.disabled=true;const pending=addNyxChatMessage('assistant','Thinking…');try{const token=await auth.currentUser?.getIdToken();if(!token)throw new Error('Please sign in again.');const response=await fetch(API+'/api/ai-assist',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({tool:'default',messages:nyxChatHistory})});const payload=await response.json();if(!response.ok||!payload.reply)throw new Error(payload.error||'Unable to get a response.');pending.textContent=payload.reply;nyxChatHistory.push({role:'assistant',content:payload.reply});}catch(error){pending.textContent=error.message||'The assistant is temporarily unavailable. Please try again.';pending.classList.add('error');nyxChatHistory.pop();}finally{nyxChatInput.disabled=false;nyxChatSend.disabled=false;nyxChatInput.focus();}});
