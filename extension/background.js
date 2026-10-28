// Клик по значку расширения открывает панель на вкладке МЭШ или открывает МЭШ
chrome.action.onClicked.addListener(tab => {
    if (tab.url && tab.url.startsWith('https://school.mos.ru/')) {
        chrome.tabs.sendMessage(tab.id, 'toggle').catch(() => {});
    } else {
        chrome.tabs.create({ url: 'https://school.mos.ru/teacher/' });
    }
});
