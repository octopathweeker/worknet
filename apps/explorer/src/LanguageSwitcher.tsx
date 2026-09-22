import React from 'react';
import {setLanguage,useLanguage} from './i18n';
import './locale.css';
export function LanguageSwitcher(){const language=useLanguage();return <label className="language-switcher"><span className="language-label">语言 / Language</span><select aria-label="语言 / Language" value={language} onChange={e=>setLanguage(e.target.value==='en'?'en':'zh')}><option value="zh" lang="zh-CN">中文</option><option value="en" lang="en">EN</option></select></label>;}
