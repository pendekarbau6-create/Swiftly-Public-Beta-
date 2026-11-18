'use strict';

(() => {

const { go, applyTheme } = window.swiftlyPage;
const api = window.swiftly;

const authPanel = document.getElementById('auth-panel');
const profilePanel = document.getElementById('account-profile');
const title = document.getElementById('account-title');
const subtitle = document.getElementById('account-subtitle');
const message = document.getElementById('account-message');
const signInForm = document.getElementById('sign-in-form');
const signUpForm = document.getElementById('sign-up-form');
const signInButton = signInForm.querySelector('[type="submit"]');
const signUpButton = signUpForm.querySelector('[type="submit"]');

function setMessage(text = '', isError = false) {
  message.textContent = text;
  message.classList.toggle('error', isError);
  message.hidden = !text;
}

function setMode(mode) {
  const creating = mode === 'signup';
  signInForm.hidden = creating;
  signUpForm.hidden = !creating;
  document.getElementById('mode-signin').classList.toggle('active', !creating);
  document.getElementById('mode-signup').classList.toggle('active', creating);
  document.getElementById('mode-signin').setAttribute('aria-pressed', String(!creating));
  document.getElementById('mode-signup').setAttribute('aria-pressed', String(creating));
  title.textContent = creating ? 'Create a Swiftly account' : 'Sign in to Swiftly';
  subtitle.textContent = creating ? 'Set up a profile for this computer.' : 'Use your profile on this computer.';
  setMessage();
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function showProfile(account) {
  authPanel.hidden = Boolean(account);
  profilePanel.hidden = !account;
  if (!account) {
    setMode('signin');
    return;
  }

  title.textContent = 'Your Swiftly account';
  subtitle.textContent = 'You’re signed in on this computer.';
  document.getElementById('profile-name').textContent = account.name;
  document.getElementById('profile-email').textContent = account.email;
  document.getElementById('profile-avatar').textContent = initials(account.name);
}

function submitWith(form, button, pendingLabel, action) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setMessage();
    const label = button.textContent;
    button.disabled = true;
    button.textContent = pendingLabel;

    try {
      const account = await action();
      if (account?.error) throw new Error(account.error);
      showProfile(account);
    } catch (error) {
      setMessage(error.message || 'Could not sign in. Try again.', true);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });
}

submitWith(signInForm, signInButton, 'Signing in…', () => api.accounts.login({
  email: document.getElementById('login-email').value,
  password: document.getElementById('login-password').value,
}));

submitWith(signUpForm, signUpButton, 'Creating account…', async () => {
  const password = document.getElementById('signup-password').value;
  const confirmation = document.getElementById('signup-confirm-password').value;
  if (password !== confirmation) throw new Error('The passwords do not match.');
  return api.accounts.signup({
    name: document.getElementById('signup-name').value,
    email: document.getElementById('signup-email').value,
    password,
  });
});

document.getElementById('mode-signin').addEventListener('click', () => setMode('signin'));
document.getElementById('mode-signup').addEventListener('click', () => setMode('signup'));
document.getElementById('back-home').addEventListener('click', () => go('swifty://start'));
document.getElementById('profile-home').addEventListener('click', () => go('swifty://start'));

document.getElementById('sign-out').addEventListener('click', async () => {
  await api.accounts.logout();
  showProfile(null);
  setMessage('You’re signed out.');
});

applyTheme();
api.accounts.current().then((account) => showProfile(account)).catch(() => showProfile(null));

})();
