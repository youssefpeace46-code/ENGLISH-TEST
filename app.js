'use strict';  
const practiceSetup = { level: null, topic: null };  
const form = document.querySelector('#practice-form');  
const startButton = document.querySelector('#start-test');  
const statusText = document.querySelector('#status');  
function selectOption(kind, selectedCard) {  
  practiceSetup[kind] = selectedCard.dataset[kind];  
  document.querySelectorAll('[data-' + kind + ']').forEach((card) => {  
    card.setAttribute('aria-pressed', String(card === selectedCard));  
  });  
  startButton.disabled = !(practiceSetup.level && practiceSetup.topic);  
  statusText.textContent = startButton.disabled  
    ? 'Select a ' + (practiceSetup.level ? 'topic' : 'level') + ' to continue.'  
    : `You're ready. Start when you like.`;  
}  
document.querySelectorAll('[data-level]').forEach((card) => {  
  card.addEventListener('click', () => selectOption('level', card));  
});  
document.querySelectorAll('[data-topic]').forEach((card) => {  
  card.addEventListener('click', () => selectOption('topic', card));  
});  
// Gemini is the test source. History is temporary and bounded to 50 prompts.  
function normalizeQuestion(question) {  
  return { ...question, sentence: question.prompt, image: null };  
}  
function normalizeAnswer(value) { return value.trim().toLowerCase(); }  
function isCorrectAnswer(value, question) {  
  return normalizeAnswer(value) === normalizeAnswer(question.answer);  
}  
const startScreen = document.querySelector('#start-screen');  
const testScreen = document.querySelector('#test-screen');  
const resultsScreen = document.querySelector('#results-screen');  
const reviewScreen = document.querySelector('#review-screen');  
const answerForm = document.querySelector('#answer-form');  
const answerInput = document.querySelector('#answer');  
const answerButton = document.querySelector('#answer-button');  
const feedback = document.querySelector('#feedback');  
const questionHeading = document.querySelector('#question-heading');  
const progress = document.querySelector('#test-progress');  
const questionImage = document.querySelector('#question-image');  
// Missing image files must not leave a broken image area in the card.  
questionImage.addEventListener('error', () => { questionImage.hidden = true; });  
let questions = [];  
let submissions = [];  
let questionIndex = 0;  
let checked = false;  
let drafts = [];  
let highestReached = 0;  
let activeSetup = null;  
let generating = false;  
let generationController = null;  
let generationVersion = 0;  
const promptHistory = [];  
const retryButton = document.querySelector('#try-again');  
const generationStatus = document.querySelector('#generation-status');  
const helpStatus = document.querySelector('#help-status');  
const helpButtons = [...document.querySelectorAll('[data-help]')];  
let helpController = null;  
let helpVersion = 0;  
let speechVersion = 0;  
const levels = { beginner: 'Beginner A1-A2', intermediate: 'Intermediate B1-B2', advanced: 'Advanced C1-C2' };  
const topics = { sports: 'Sports', cooking: 'Cooking', movies: 'Movies', school: 'School', travel: 'Travel', work: 'Work', 'daily-life': 'Daily Life', 'random-mix': 'Random Mix' };  
function requestContext() {  
  const setup = activeSetup || practiceSetup;  
  return { level: levels[setup.level], topic: topics[setup.topic] };  
}  
async function postJSON(path, data, signal) {  
  const response = await fetch(path, {  
    method: 'POST', headers: { 'Content-Type': 'application/json' },  
    body: JSON.stringify(data), signal  
  });  
  if (!response.ok) throw new Error('Request failed');  
  return response.json();  
}  
function stopHelp() {  
  helpVersion += 1;  
  speechVersion += 1;  
  if (helpController) helpController.abort();  
  helpController = null;  
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();  
  helpButtons.forEach(button => { button.disabled = false; });  
  helpStatus.textContent = '';  
}  
function speakHint(text, language) {  
  if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) { 
    helpStatus.textContent = text + ' Audio is unavailable in this browser.';  
    return;  
  }  
  const speech = window.speechSynthesis;  
  speech.cancel();  
  const token = ++speechVersion;  
  const utterance = new SpeechSynthesisUtterance(text);  
  utterance.lang = language === 'ar' ? 'ar-SA' : 'en-US';  
  const voices = speech.getVoices();  
  utterance.voice = voices.find(voice => voice.lang.toLowerCase() === utterance.lang.toLowerCase())  
    || voices.find(voice => voice.lang.toLowerCase().startsWith(language))  
    || null; // Let the browser select a language voice rather than forcing the wrong language.  
  utterance.rate = 0.9;  
  utterance.onerror = () => {  
    if (token === speechVersion) helpStatus.textContent = text + ' Audio could not play. You can read the hint above.';  
  };  
  speech.speak(utterance);  
}  
helpButtons.forEach(button => button.addEventListener('click', async () => {  
  if (helpController || generating || !questions.length) return;  
  stopHelp();  
  const version = helpVersion;  
  helpController = new AbortController();  
  const controller = helpController;  
  helpButtons.forEach(control => { control.disabled = true; });  
  helpStatus.lang = button.dataset.help;  
  helpStatus.dir = button.dataset.help === 'ar' ? 'rtl' : 'ltr';  
  helpStatus.textContent = 'Preparing help...';  
  try {  
    const question = questions[questionIndex];  
    const result = await postJSON('/api/help', {  
      ...requestContext(), language: button.dataset.help,  
      question: question.sentence, answer: question.answer  
    }, controller.signal);  
    if (version !== helpVersion) return;  
    if (typeof result.hint !== 'string' || !result.hint.trim()) throw new Error('Invalid hint');  
    helpStatus.textContent = result.hint;  
    if (button.dataset.help === 'en') speakHint(result.hint, 'en');  
  } catch (error) {  
    if (version === helpVersion && error.name !== 'AbortError')  
      helpStatus.textContent = 'Help is unavailable right now. Please try again.';  
  } finally {  
    if (version === helpVersion) {  
      helpController = null;  
      helpButtons.forEach(control => { control.disabled = false; });  
    }  
  }  
}));  
async function startGeneratedTest(forceNew = false) {  
  if (generating) return;  
  const sameAttempt = !forceNew && activeSetup  
    && activeSetup.level === practiceSetup.level && activeSetup.topic === practiceSetup.topic;  
  if (sameAttempt && questions.length) {  
    questionIndex = 0;  
    showScreen(testScreen);  
    renderQuestion();  
    return;  
  }  
  generating = true;  
  const version = ++generationVersion;  
  const controller = new AbortController();  
  generationController = controller;  
  stopHelp();  
  startButton.disabled = true;  
  retryButton.disabled = true;  
  document.querySelectorAll('[data-level], [data-topic], [data-restart]').forEach(button => { button.disabled = true; });  
  const message = resultsScreen.hidden ? statusText : generationStatus;  
  message.textContent = 'Preparing your 10 questions...';  
  try {  
    const result = await postJSON('/api/generate-test', {  
      level: levels[practiceSetup.level], topic: topics[practiceSetup.topic],  
      previous_prompts: promptHistory.slice(-50)  
    }, controller.signal);  
    if (version !== generationVersion) return;  
    if (!Array.isArray(result.questions) || result.questions.length !== 10  
      || result.questions.some(q => typeof q.prompt !== 'string' || !q.prompt.trim()  
        || typeof q.answer !== 'string' || !q.answer.trim() || typeof q.explanation !== 'string'  
        || q.image !== null)) throw new Error('Invalid test');  
    const previous = new Set(promptHistory.map(text => text.trim().toLowerCase()));  
    if (result.questions.some(q => previous.has(q.prompt.trim().toLowerCase()))) throw new Error('Repeated test');  
    questions = result.questions.map(normalizeQuestion);  
    promptHistory.push(...result.questions.map(q => q.prompt));  
    if (promptHistory.length > 50) promptHistory.splice(0, promptHistory.length - 50);  
    submissions = []; 
    drafts = [];  
    highestReached = 0;  
    questionIndex = 0;  
    activeSetup = { ...practiceSetup };  
    document.querySelector('#test-topic').textContent =  
      document.querySelector('[data-topic][aria-pressed=true] .icon').textContent + ' ' + topics[practiceSetup.topic];  
    message.textContent = '';  
    showScreen(testScreen);  
    renderQuestion();  
  } catch (error) {  
    if (version !== generationVersion || error.name === 'AbortError') return;  
    message.textContent = 'We could not prepare a new test. Check that the backend is running and try again.';  
  } finally {  
    if (version !== generationVersion) return;  
    generationController = null;  
    generating = false;  
    startButton.disabled = !(practiceSetup.level && practiceSetup.topic);  
    retryButton.disabled = false;  
    document.querySelectorAll('[data-level], [data-topic], [data-restart]').forEach(button => { button.disabled = false; });  
  }  
}  
retryButton.addEventListener('click', () => startGeneratedTest(true));  
const backButton = document.querySelector('#question-back');  
const forwardButton = document.querySelector('#question-forward');  
function showScreen(screen) {  
  stopHelp();  
  [startScreen, testScreen, resultsScreen, reviewScreen].forEach(view => { view.hidden = view !== screen; });  
}  
function completedSentence(question) { return question.sentence.replace('______', question.answer); }  
function addText(parent, tag, text) {  
  const element = document.createElement(tag);  
  element.textContent = text;  
  parent.append(element);  
  return element;  
}  
function updateNavigation() {  
  forwardButton.disabled = questionIndex >= highestReached;  
  progress.value = questionIndex + 1;  
  progress.setAttribute('aria-valuetext', 'Question ' + (questionIndex + 1) + ' of ' + questions.length);  
}  
function saveDraft() {  
  if (!checked) drafts[questionIndex] = answerInput.value;  
}  
function renderFeedback(entry) {  
  feedback.className = 'feedback ' + (entry.correct ? 'correct' : 'incorrect');  
  feedback.replaceChildren();  
  addText(feedback, 'strong', entry.correct ? '\u2713 Correct!' : '\u2715 Not quite.');  
  if (entry.correct) addText(feedback, 'p', completedSentence(entry.question));  
  addText(feedback, 'p', 'Correct answer: ' + entry.question.answer).className = 'correct-answer';  
  addText(feedback, 'p', '\uD83D\uDCA1 ' + entry.question.explanation).className = 'explanation';  
  feedback.hidden = false;  
}  
function renderQuestion() {  
  stopHelp();  
  const question = questions[questionIndex];  
  const submission = submissions[questionIndex];  
  checked = Boolean(submission);  
  questionHeading.textContent = 'Question ' + (questionIndex + 1) + ' of ' + questions.length;  
  updateNavigation();  
  document.querySelector('#sentence').textContent = question.sentence;  
  document.querySelector('.question-card .instruction').textContent = question.sentence.includes('______') ? 'Complete the sentence:' : 'Type your answer:';  
  questionImage.hidden = !question.image;  
  if (question.image) {  
    questionImage.src = question.image;  
    questionImage.alt = question.imageAlt || 'Image for this question';  
  } else { questionImage.removeAttribute('src'); }  
  answerInput.value = submission ? submission.userAnswer : (drafts[questionIndex] || '');  
  answerInput.readOnly = checked;  
  answerInput.setCustomValidity('');  
  answerButton.textContent = checked ? 'Next Question \u2192' : 'Check Answer';  
  feedback.hidden = true;  
  feedback.replaceChildren();  
  if (submission) renderFeedback(submission);  
  (checked ? answerButton : answerInput).focus();  
}  
backButton.addEventListener('click', () => {  
  saveDraft();  
  if (questionIndex === 0) {  
    showScreen(startScreen);  
    startButton.focus();  
    return;  
  }  
  questionIndex -= 1;  
  renderQuestion();  
});  
forwardButton.addEventListener('click', () => {  
  if (questionIndex >= highestReached) return;  
  saveDraft();  
  questionIndex += 1;  
  renderQuestion();  
}); 
form.addEventListener('submit', event => {  
  event.preventDefault();  
  if (practiceSetup.level && practiceSetup.topic) startGeneratedTest();  
});  
answerInput.addEventListener('input', () => {  
  answerInput.setCustomValidity('');  
  saveDraft();  
});  
answerForm.addEventListener('submit', event => {  
  event.preventDefault();  
  if (checked) {  
    if (questionIndex === questions.length - 1) renderResults();  
    else {  
      questionIndex += 1;  
      highestReached = Math.max(highestReached, questionIndex);  
      renderQuestion();  
    }  
    return;  
  }  
  const userAnswer = answerInput.value.trim();  
  if (!userAnswer) {  
    answerInput.setCustomValidity('Please type an answer.');  
    answerInput.reportValidity();  
    return;  
  }  
  stopHelp();  
  const question = questions[questionIndex];  
  const correct = isCorrectAnswer(userAnswer, question);  
  submissions[questionIndex] = { question, userAnswer, correct };  
  drafts[questionIndex] = userAnswer;  
  checked = true;  
  answerInput.readOnly = true;  
  renderFeedback(submissions[questionIndex]);  
  updateNavigation();  
  answerButton.textContent = 'Next Question \u2192';  
  answerButton.focus();  
});  
function renderResults() {  
  const correct = submissions.filter(entry => entry.correct).length;  
  document.querySelector('#score').textContent = correct + ' / ' + questions.length;  
  document.querySelector('#percentage').textContent = Math.round(correct / questions.length * 100) + '%';  
  document.querySelector('#correct-count').textContent = 'Correct answers: ' + correct;  
  document.querySelector('#incorrect-count').textContent = 'Incorrect answers: ' + (questions.length - correct);  
  showScreen(resultsScreen);  
  document.querySelector('#results-heading').focus();  
}  
document.querySelector('#review-button').addEventListener('click', () => {  
  const list = document.querySelector('#review-list');  
  list.replaceChildren();  
  submissions.forEach((entry, index) => {  
    const item = document.createElement('li');  
    item.className = 'review-item';  
    addText(item, 'h3', 'Question ' + (index + 1) + (entry.correct ? ' - Correct' : ' - Incorrect'));  
    addText(item, 'p', entry.question.sentence);  
    if (entry.correct) addText(item, 'p', 'Your answer: ' + entry.userAnswer);  
    addText(item, 'p', 'Correct answer: ' + entry.question.answer).className = 'correct-answer';  
    addText(item, 'p', completedSentence(entry.question));  
    if (!entry.correct) addText(item, 'p', '\uD83D\uDCA1 ' + entry.question.explanation).className = 'explanation';  
    list.append(item);  
  });  
  showScreen(reviewScreen);  
  document.querySelector('#review-heading').focus();  
});  
function resetTest() {  
  generationVersion += 1;  
  if (generationController) generationController.abort();  
  generationController = null;  
  generating = false;  
  questions = [];  
  submissions = [];  
  questionIndex = 0;  
  checked = false;  
  drafts = [];  
  highestReached = 0;  
  activeSetup = null;  
  answerInput.value = '';  
  answerInput.readOnly = false;  
  answerInput.setCustomValidity('');  
  feedback.replaceChildren();  
  feedback.hidden = true;  
  document.querySelector('#sentence').textContent = '';  
  document.querySelector('#review-list').replaceChildren();  
  questionImage.hidden = true;  
  questionImage.removeAttribute('src');  
  progress.value = 0;  
  progress.setAttribute('aria-valuetext', 'No test in progress');  
  questionHeading.textContent = 'Question 1 of 10';  
  answerButton.textContent = 'Check Answer';  
  generationStatus.textContent = '';  
  ['#score', '#percentage', '#correct-count', '#incorrect-count', '#test-topic'].forEach(selector => {  
    document.querySelector(selector).textContent = '';  
  });  
  retryButton.disabled = false;  
  document.querySelectorAll('[data-level], [data-topic], [data-restart]').forEach(button => { button.disabled = false; }); 
  startButton.disabled = !(practiceSetup.level && practiceSetup.topic);  
  showScreen(startScreen);  
  statusText.textContent = 'Choose your level and topic for another test.';  
  startButton.focus();  
}  
document.querySelectorAll('[data-restart]').forEach(button => button.addEventListener('click', resetTest));  
document.querySelector('#logo-home').addEventListener('click', resetTest);  
  
 
