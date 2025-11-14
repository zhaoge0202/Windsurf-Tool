/**
 * 邮箱API验证码接收器
 * 基于第三方邮件API服务（如 tempmail 等）
 * 配置项：serverUrl, adminEmail, adminPassword, emailDomain
 */
class EmailAPIHelper {
  constructor(config) {
    this.config = config;
    this.token = null;
    this.tokenExpireTime = null;
    this.activeMonitors = new Map(); // 并发监控映射表
  }

  /**
   * 获取API Token
   */
  async getToken() {
    try {
      // 检查Token是否仍有效
      if (this.token && this.tokenExpireTime && Date.now() < this.tokenExpireTime) {
        return this.token;
      }

      const response = await fetch(`${this.config.serverUrl}/api/user/token/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: this.config.adminEmail,
          password: this.config.adminPassword
        })
      });

      const result = await response.json();
      if (result.code === 200) {
        this.token = result.data.token;
        // Token有效期设为1小时
        this.tokenExpireTime = Date.now() + 3600000;
        console.log('[EmailAPI] Token获取成功');
        return this.token;
      }
      throw new Error(result.message || 'Get token failed');
    } catch (error) {
      console.error('[EmailAPI] Token获取失败:', error);
      throw error;
    }
  }

  /**
   * 通用认证请求函数 - 自动处理Token失效
   */
  async makeAuthenticatedRequest(url, options = {}) {
    if (!this.token) {
      await this.getToken();
    }

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': this.token,
      ...options.headers
    };

    let response = await fetch(url, { ...options, headers });
    let result = await response.json();

    // 检查Token是否失效 (401错误)
    if (response.status === 401 || result.code === 401) {
      console.log('[EmailAPI] Token失效，重新获取...');
      await this.getToken();
      headers.Authorization = this.token;
      response = await fetch(url, { ...options, headers });
      result = await response.json();
    }

    return { response, result };
  }

  /**
   * 创建邮箱账户
   */
  async createEmail() {
    try {
      const email = `${this.generateRandomEmail()}@${this.config.emailDomain}`;
      
      const { result } = await this.makeAuthenticatedRequest(
        `${this.config.serverUrl}/api/user/account/add`,
        {
          method: 'POST',
          body: JSON.stringify({ email })
        }
      );

      if (result.code === 200) {
        console.log('[EmailAPI] 邮箱创建成功:', email);
        return {
          email: email,
          accountId: result.data.accountId,
          createdAt: new Date().toISOString()
        };
      }
      throw new Error(result.message || 'Create email failed');
    } catch (error) {
      console.error('[EmailAPI] 邮箱创建失败:', error);
      throw error;
    }
  }

  /**
   * 生成随机邮箱用户名
   */
  generateRandomEmail() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 12; i++) {
      result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
  }

  /**
   * 启动验证码监控
   */
  async startMonitoring(email) {
    try {
      // 如果已经在监控这个邮箱，先停止
      if (this.activeMonitors.has(email)) {
        this.stopMonitoringForEmail(email);
      }

      const startTime = Date.now();
      console.log(`[EmailAPI] 启动监控: ${email}, 监控开始时间: ${new Date(startTime).toISOString()} (${startTime})`);

      // 每5秒检查一次验证码
      const intervalId = setInterval(async () => {
        await this.checkForVerificationCode(email, startTime);
      }, 5000);

      this.activeMonitors.set(email, { intervalId, startTime });
      console.log(`[EmailAPI] 活跃监控数: ${this.activeMonitors.size}`);
    } catch (error) {
      console.error('[EmailAPI] 启动监控失败:', error);
      throw error;
    }
  }

  /**
   * 检查验证码
   */
  async checkForVerificationCode(email, startTime) {
    try {
      const { result } = await this.makeAuthenticatedRequest(
        `${this.config.serverUrl}/api/user/email/list`,
        {
          method: 'POST',
          body: JSON.stringify({
            toEmail: email,
            sendEmail: '',
            num: 1,
            size: 10,
            timeSort: 'desc',
            type: 0,
            isDel: 0
          })
        }
      );

      if (result.code === 200 && result.data && result.data.length > 0) {
        console.log(`[EmailAPI] 收到 ${result.data.length} 封邮件`);

        // 过滤出监控开始时间之后的邮件
        const newEmails = result.data.filter(emailData => {
          if (!emailData.createTime) return false;

          // 解析邮件时间 "2025-11-14 06:21:07"
          // createTime 是 UTC 时间字符串，需要加 Z 后缀正确解析
          const emailTimeStr = emailData.createTime.replace(' ', 'T') + 'Z';
          const emailTime = new Date(emailTimeStr).getTime();

          // 调试日志
          const emailTimeLocal = new Date(emailTime).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'});
          const startTimeLocal = new Date(startTime).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'});
          console.log(`[EmailAPI] 邮件时间: ${emailData.createTime} UTC → ${emailTimeLocal} (${emailTime})`);
          console.log(`[EmailAPI] 监控开始: ${startTimeLocal} (${startTime})`);
          console.log(`[EmailAPI] 是否新邮件: ${emailTime > startTime}`);

          return emailTime > startTime;
        });

        console.log(`[EmailAPI] 过滤后有 ${newEmails.length} 封新邮件`);

        if (newEmails.length > 0) {
          // 尝试从每封邮件中提取验证码
          for (const emailData of newEmails) {
            console.log(`[EmailAPI] 检查邮件: ${emailData.subject || '无主题'}`);

            // 优先从 text 字段提取（纯文本格式更可靠）
            let code = null;
            if (emailData.text) {
              code = this.extractVerificationCode(emailData.text);
            }

            // 如果 text 字段没有找到，尝试从 content 字段提取（HTML格式）
            if (!code && emailData.content) {
              code = this.extractVerificationCode(emailData.content);
            }

            if (code) {
              console.log(`[EmailAPI] 找到验证码: ${code}`);
              return code;
            }
          }
        }
      }
    } catch (error) {
      console.error(`[EmailAPI] 检查验证码失败: ${email}`, error);
    }
    return null;
  }

  /**
   * 提取验证码 - 支持多种格式
   */
  extractVerificationCode(htmlContent) {
    if (!htmlContent) return null;

    const patterns = [
      // Windsurf 官方格式 - class="code" 中的验证码
      /class="code"[^>]*>(\d{6})<\/h1>/i,
      /class="code"[^>]*>(\d{6})<\/[^>]*>/i,
      // Windsurf 官方格式 - 星号分隔的验证码
      /\*{3,}\s*(\d{6})\s*\*{3,}/,
      // Windsurf 官方格式 - "6 digit code" 后跟验证码
      /6\s+digit\s+code[^0-9]*(\d{6})/i,
      /6\s+digit\s+code[^0-9]*<[^>]*>(\d{6})<\/[^>]*>/i,
      // Windsurf 格式
      /Your verification code is:\s*<b>(\d{6})<\/b>/i,
      /Your verification code is:\s*(\d{6})/i,
      /verification code is:\s*<b>(\d{6})<\/b>/i,
      /verification code is:\s*(\d{6})/i,
      /code[：:]\s*<b>(\d{6})<\/b>/i,
      /code[：:]\s*(\d{6})/i,
      // 中文格式
      /验证码[：:]\s*<b>(\d{6})<\/b>/,
      /验证码[：:]\s*(\d{6})/,
      // HTML标签格式
      /<b>(\d{6})<\/b>/i,
      /<strong>(\d{6})<\/strong>/i,
      /<span[^>]*>(\d{6})<\/span>/i,
      /<h1[^>]*>(\d{6})<\/h1>/i,
      // 纯数字格式（最后的备选方案）
      /\b(\d{6})\b/
    ];

    for (const pattern of patterns) {
      const match = htmlContent.match(pattern);
      if (match && match[1] && match[1].length === 6) {
        console.log(`[EmailAPI] 验证码提取成功: ${match[1]}`);
        return match[1];
      }
    }

    // 如果没有匹配到，输出调试信息
    console.log('[EmailAPI] 未能提取验证码，邮件内容预览:');
    console.log(htmlContent.substring(0, 500));

    return null;
  }

  /**
   * 停止单个邮箱的监控
   */
  stopMonitoringForEmail(email) {
    const monitor = this.activeMonitors.get(email);
    if (monitor) {
      clearInterval(monitor.intervalId);
      this.activeMonitors.delete(email);
      console.log(`[EmailAPI] 停止监控: ${email}`);
    }
  }

  /**
   * 停止所有监控
   */
  stopAllMonitoring() {
    for (const [, monitor] of this.activeMonitors.entries()) {
      clearInterval(monitor.intervalId);
    }
    this.activeMonitors.clear();
    console.log('[EmailAPI] 已停止所有监控');
  }

  /**
   * 获取验证码（阻塞式，等待直到获取到验证码或超时）
   * @param {string} email - 邮箱地址
   * @param {number} maxWaitTime - 最大等待时间（毫秒）
   * @param {number} customStartTime - 自定义监控开始时间（可选，用于处理延迟场景）
   */
  async getVerificationCode(email, maxWaitTime = 120000, customStartTime = null) {
    return new Promise((resolve, reject) => {
      // 如果提供了自定义开始时间，使用它；否则使用当前时间
      const startTime = customStartTime || Date.now();
      const callTime = Date.now(); // 记录实际调用时间，用于超时计算
      let isResolved = false;

      console.log(`[EmailAPI] 开始获取验证码: ${email}`);
      console.log(`[EmailAPI] 监控开始时间: ${new Date(startTime).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})} (${startTime})`);
      if (customStartTime) {
        console.log(`[EmailAPI] 实际调用时间: ${new Date(callTime).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})} (延迟了 ${(callTime - startTime) / 1000} 秒)`);
      }

      const checkInterval = setInterval(async () => {
        if (Date.now() - callTime > maxWaitTime) {
          clearInterval(checkInterval);
          if (!isResolved) {
            isResolved = true;
            reject(new Error('获取验证码超时'));
          }
          return;
        }

        try {
          const code = await this.checkForVerificationCode(email, startTime);
          if (code && !isResolved) {
            isResolved = true;
            clearInterval(checkInterval);
            resolve(code);
          }
        } catch (error) {
          console.error('[EmailAPI] 检查验证码出错:', error);
        }
      }, 5000);
    });
  }

  /**
   * 测试连接
   */
  async testConnection() {
    try {
      await this.getToken();
      return { success: true, message: 'API连接成功' };
    } catch (error) {
      return { success: false, message: `API连接失败: ${error.message}` };
    }
  }
}

module.exports = EmailAPIHelper;

