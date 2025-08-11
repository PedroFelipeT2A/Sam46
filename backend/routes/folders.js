const express = require('express');
const db = require('../config/database');
const authMiddleware = require('../middlewares/authMiddleware');
const SSHManager = require('../config/SSHManager');

const router = express.Router();

// GET /api/folders - Lista pastas do usuário
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // Buscar pastas do usuário na tabela streamings
    const [rows] = await db.execute(
      `SELECT 
        codigo as id,
        identificacao as nome,
        codigo_servidor,
        espaco,
        espaco_usado,
        data_cadastro,
        status
       FROM streamings 
       WHERE codigo_cliente = ? AND status = 1`,
      [userId]
    );

    // Se não houver pastas, criar uma pasta padrão
    if (rows.length === 0) {
      const userEmail = req.user.email ? req.user.email.split('@')[0] : `user_${userId}`;
      res.json([{ id: 1, nome: userEmail }]);
    } else {
      res.json(rows);
    }
  } catch (err) {
    console.error('Erro ao buscar pastas:', err);
    res.status(500).json({ error: 'Erro ao buscar pastas', details: err.message });
  }
});

// POST /api/folders - Cria nova pasta
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { nome } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome da pasta é obrigatório' });
    
    const userId = req.user.id;
    const userEmail = req.user.email ? req.user.email.split('@')[0] : `user_${userId}`;
    const userLogin = userEmail;

    // Buscar servidor padrão ou do usuário
    const [userServerRows] = await db.execute(
      'SELECT codigo_servidor FROM streamings WHERE codigo_cliente = ? LIMIT 1',
      [userId]
    );

    const serverId = userServerRows.length > 0 ? userServerRows[0].codigo_servidor : 1;

    // Verificar se pasta já existe
    const [existingRows] = await db.execute(
      'SELECT codigo FROM streamings WHERE identificacao = ? AND codigo_cliente = ?',
      [nome, userId]
    );

    if (existingRows.length > 0) {
      return res.status(400).json({ 
        error: 'Já existe uma pasta com este nome',
        details: 'Escolha um nome diferente para a pasta'
      });
    }

    // Criar entrada na tabela streamings para representar a pasta
    const [result] = await db.execute(
      `INSERT INTO streamings (
        codigo_cliente, codigo_servidor, login, senha, senha_transmissao,
        espectadores, bitrate, espaco, ftp_dir, identificacao, email,
        data_cadastro, aplicacao, status
      ) VALUES (?, ?, ?, '', '', 100, 2500, 1000, ?, ?, ?, NOW(), 'live', 1)`,
      [userId, serverId, userLogin, `/${userLogin}/${nome}`, nome, req.user.email]
    );

    try {
      // Garantir que o diretório do usuário existe no servidor
      await SSHManager.createUserDirectory(serverId, userLogin);
      
      // Criar a pasta específica no servidor via SSH
      await SSHManager.createUserFolder(serverId, userLogin, nome);
      
      console.log(`✅ Pasta ${nome} criada no servidor para usuário ${userLogin}`);

      // Definir permissões corretas
      const folderPath = `/usr/local/WowzaStreamingEngine/content/${userLogin}/${nome}`;
      await SSHManager.executeCommand(serverId, `chmod 755 "${folderPath}"`);
      await SSHManager.executeCommand(serverId, `chown -R wowza:wowza "${folderPath}"`);
      
    } catch (sshError) {
      console.error('Erro ao criar pasta no servidor:', sshError);
      // Remover entrada do banco se falhou no servidor
      await db.execute('DELETE FROM streamings WHERE codigo = ?', [result.insertId]);
      return res.status(500).json({ 
        error: 'Erro ao criar pasta no servidor',
        details: sshError.message 
      });
    }

    res.status(201).json({
      id: result.insertId,
      nome: nome,
      espaco: 1000,
      espaco_usado: 0,
      servidor_id: serverId
    });
  } catch (err) {
    console.error('Erro ao criar pasta:', err);
    res.status(500).json({ error: 'Erro ao criar pasta', details: err.message });
  }
});

// PUT /api/folders/:id - Edita pasta
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const folderId = req.params.id;
    const { nome } = req.body;
    const userId = req.user.id;
    const userLogin = req.user.email.split('@')[0];

    if (!nome) {
      return res.status(400).json({ error: 'Nome da pasta é obrigatório' });
    }

    // Verificar se a pasta pertence ao usuário
    const [folderRows] = await db.execute(
      'SELECT codigo, identificacao, codigo_servidor FROM streamings WHERE codigo = ? AND codigo_cliente = ?',
      [folderId, userId]
    );

    if (folderRows.length === 0) {
      return res.status(404).json({ error: 'Pasta não encontrada' });
    }

    const folder = folderRows[0];
    const serverId = folder.codigo_servidor || 1;
    const oldFolderName = folder.identificacao;

    // Verificar se novo nome já existe
    const [existingRows] = await db.execute(
      'SELECT codigo FROM streamings WHERE identificacao = ? AND codigo_cliente = ? AND codigo != ?',
      [nome, userId, folderId]
    );

    if (existingRows.length > 0) {
      return res.status(400).json({ 
        error: 'Já existe uma pasta com este nome',
        details: 'Escolha um nome diferente para a pasta'
      });
    }

    try {
      // Renomear pasta no servidor via SSH
      const oldPath = `/usr/local/WowzaStreamingEngine/content/${userLogin}/${oldFolderName}`;
      const newPath = `/usr/local/WowzaStreamingEngine/content/${userLogin}/${nome}`;
      
      // Verificar se pasta antiga existe
      const checkCommand = `test -d "${oldPath}" && echo "EXISTS" || echo "NOT_EXISTS"`;
      const checkResult = await SSHManager.executeCommand(serverId, checkCommand);
      
      if (checkResult.stdout.includes('EXISTS')) {
        // Renomear pasta
        await SSHManager.executeCommand(serverId, `mv "${oldPath}" "${newPath}"`);
        
        // Definir permissões corretas
        await SSHManager.executeCommand(serverId, `chmod 755 "${newPath}"`);
        await SSHManager.executeCommand(serverId, `chown -R wowza:wowza "${newPath}"`);
        
        console.log(`✅ Pasta renomeada no servidor: ${oldFolderName} -> ${nome}`);
      } else {
        // Se pasta não existe no servidor, criar nova
        await SSHManager.createUserFolder(serverId, userLogin, nome);
        console.log(`✅ Nova pasta criada no servidor: ${nome}`);
      }
      
    } catch (sshError) {
      console.error('Erro ao renomear pasta no servidor:', sshError);
      return res.status(500).json({ 
        error: 'Erro ao renomear pasta no servidor',
        details: sshError.message 
      });
    }

    // Atualizar nome no banco de dados
    await db.execute(
      'UPDATE streamings SET identificacao = ?, ftp_dir = ? WHERE codigo = ?',
      [nome, `/${userLogin}/${nome}`, folderId]
    );

    // Atualizar caminhos dos vídeos no banco se necessário
    await db.execute(
      `UPDATE videos SET 
       url = REPLACE(url, '/${userLogin}/${oldFolderName}/', '/${userLogin}/${nome}/'),
       caminho = REPLACE(caminho, '/${oldFolderName}/', '/${nome}/')
       WHERE pasta = ? AND codigo_cliente = ?`,
      [folderId, userId]
    );

    console.log(`✅ Pasta ${oldFolderName} renomeada para ${nome} no banco de dados`);

    res.json({ 
      success: true, 
      message: 'Pasta renomeada com sucesso',
      old_name: oldFolderName,
      new_name: nome
    });
  } catch (err) {
    console.error('Erro ao editar pasta:', err);
    res.status(500).json({ error: 'Erro ao editar pasta', details: err.message });
  }
});

// DELETE /api/folders/:id - Remove pasta
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const folderId = req.params.id;
    const userId = req.user.id;
    const userLogin = req.user.email.split('@')[0];

    // Verificar se a pasta pertence ao usuário
    const [folderRows] = await db.execute(
      'SELECT codigo, identificacao, codigo_servidor FROM streamings WHERE codigo = ? AND codigo_cliente = ?',
      [folderId, userId]
    );

    if (folderRows.length === 0) {
      return res.status(404).json({ error: 'Pasta não encontrada' });
    }

    const folder = folderRows[0];
    const serverId = folder.codigo_servidor || 1;
    const folderName = folder.identificacao;

    // Verificar se há vídeos na pasta
    const [videoCountRows] = await db.execute(
      'SELECT COUNT(*) as count FROM videos WHERE pasta = ? AND codigo_cliente = ?',
      [folderId, userId]
    );

    if (videoCountRows[0].count > 0) {
      return res.status(400).json({ 
        error: 'Não é possível excluir pasta que contém vídeos',
        details: `A pasta contém ${videoCountRows[0].count} vídeo(s). Remova todos os vídeos antes de excluir a pasta.`
      });
    }

    // Verificar se pasta está sendo usada em playlists
    const [playlistRows] = await db.execute(
      'SELECT COUNT(*) as count FROM playlists_videos WHERE path_video LIKE ?',
      [`%/${userLogin}/${folderName}/%`]
    );

    if (playlistRows[0].count > 0) {
      return res.status(400).json({ 
        error: 'Não é possível excluir pasta que está sendo usada em playlists',
        details: `A pasta está sendo usada em ${playlistRows[0].count} item(s) de playlist. Remova-os primeiro.`
      });
    }

    try {
      // Remover pasta do servidor via SSH
      const remoteFolderPath = `/usr/local/WowzaStreamingEngine/content/${userLogin}/${folderName}`;
      
      // Verificar se pasta existe no servidor
      const checkCommand = `test -d "${remoteFolderPath}" && echo "EXISTS" || echo "NOT_EXISTS"`;
      const checkResult = await SSHManager.executeCommand(serverId, checkCommand);
      
      if (checkResult.stdout.includes('EXISTS')) {
        // Verificar se pasta está realmente vazia no servidor
        const listCommand = `find "${remoteFolderPath}" -type f | wc -l`;
        const listResult = await SSHManager.executeCommand(serverId, listCommand);
        const fileCount = parseInt(listResult.stdout.trim()) || 0;
        
        if (fileCount > 0) {
          return res.status(400).json({ 
            error: 'Pasta contém arquivos no servidor',
            details: `Encontrados ${fileCount} arquivo(s) no servidor. Remova-os primeiro.`
          });
        }
        
        // Remover pasta vazia
        await SSHManager.executeCommand(serverId, `rmdir "${remoteFolderPath}"`);
        console.log(`✅ Pasta ${folderName} removida do servidor`);
      } else {
        console.log(`⚠️ Pasta ${folderName} não existe no servidor, removendo apenas do banco`);
      }
    } catch (sshError) {
      console.error('Erro ao remover pasta do servidor:', sshError.message);
      return res.status(500).json({ 
        error: 'Erro ao remover pasta do servidor',
        details: sshError.message 
      });
    }

    // Remover pasta
    await db.execute(
      'DELETE FROM streamings WHERE codigo = ? AND codigo_cliente = ?',
      [folderId, userId]
    );

    console.log(`✅ Pasta ${folderName} removida do banco de dados`);

    res.json({ success: true, message: 'Pasta removida com sucesso' });
  } catch (err) {
    console.error('Erro ao remover pasta:', err);
    res.status(500).json({ error: 'Erro ao remover pasta', details: err.message });
  }
});

// GET /api/folders/:id/info - Informações detalhadas da pasta
router.get('/:id/info', authMiddleware, async (req, res) => {
  try {
    const folderId = req.params.id;
    const userId = req.user.id;
    const userLogin = req.user.email.split('@')[0];

    // Buscar dados da pasta
    const [folderRows] = await db.execute(
      `SELECT 
        codigo as id,
        identificacao as nome,
        codigo_servidor,
        espaco,
        espaco_usado,
        data_cadastro,
        ftp_dir
       FROM streamings 
       WHERE codigo = ? AND codigo_cliente = ?`,
      [folderId, userId]
    );

    if (folderRows.length === 0) {
      return res.status(404).json({ error: 'Pasta não encontrada' });
    }

    const folder = folderRows[0];
    const serverId = folder.codigo_servidor || 1;
    const folderName = folder.nome;

    // Verificar se pasta existe no servidor
    let serverInfo = null;
    try {
      const remoteFolderPath = `/usr/local/WowzaStreamingEngine/content/${userLogin}/${folderName}`;
      const checkCommand = `test -d "${remoteFolderPath}" && ls -la "${remoteFolderPath}" | head -1 || echo "NOT_EXISTS"`;
      const checkResult = await SSHManager.executeCommand(serverId, checkCommand);
      
      if (!checkResult.stdout.includes('NOT_EXISTS')) {
        // Contar arquivos na pasta
        const countCommand = `find "${remoteFolderPath}" -type f | wc -l`;
        const countResult = await SSHManager.executeCommand(serverId, countCommand);
        const fileCount = parseInt(countResult.stdout.trim()) || 0;
        
        // Calcular tamanho da pasta
        const sizeCommand = `du -sb "${remoteFolderPath}" 2>/dev/null | cut -f1 || echo "0"`;
        const sizeResult = await SSHManager.executeCommand(serverId, sizeCommand);
        const folderSize = parseInt(sizeResult.stdout.trim()) || 0;
        
        serverInfo = {
          exists: true,
          file_count: fileCount,
          size_bytes: folderSize,
          size_mb: Math.ceil(folderSize / (1024 * 1024)),
          path: remoteFolderPath
        };
      } else {
        serverInfo = {
          exists: false,
          file_count: 0,
          size_bytes: 0,
          size_mb: 0,
          path: remoteFolderPath
        };
      }
    } catch (sshError) {
      console.warn('Erro ao verificar pasta no servidor:', sshError.message);
      serverInfo = {
        exists: false,
        error: sshError.message
      };
    }

    // Contar vídeos no banco
    const [videoCountRows] = await db.execute(
      'SELECT COUNT(*) as count FROM videos WHERE pasta = ? AND codigo_cliente = ?',
      [folderId, userId]
    );

    res.json({
      ...folder,
      video_count_db: videoCountRows[0].count,
      server_info: serverInfo,
      percentage_used: folder.espaco > 0 ? Math.round((folder.espaco_usado / folder.espaco) * 100) : 0
    });
  } catch (err) {
    console.error('Erro ao buscar informações da pasta:', err);
    res.status(500).json({ error: 'Erro ao buscar informações da pasta', details: err.message });
  }
});

// POST /api/folders/:id/sync - Sincronizar pasta com servidor
router.post('/:id/sync', authMiddleware, async (req, res) => {
  try {
    const folderId = req.params.id;
    const userId = req.user.id;
    const userLogin = req.user.email.split('@')[0];

    // Buscar dados da pasta
    const [folderRows] = await db.execute(
      'SELECT identificacao, codigo_servidor FROM streamings WHERE codigo = ? AND codigo_cliente = ?',
      [folderId, userId]
    );

    if (folderRows.length === 0) {
      return res.status(404).json({ error: 'Pasta não encontrada' });
    }

    const folder = folderRows[0];
    const serverId = folder.codigo_servidor || 1;
    const folderName = folder.identificacao;

    try {
      // Garantir que diretório do usuário existe
      await SSHManager.createUserDirectory(serverId, userLogin);
      
      // Garantir que pasta específica existe
      await SSHManager.createUserFolder(serverId, userLogin, folderName);
      
      // Limpar arquivos temporários e corrompidos
      const cleanupCommand = `find "/usr/local/WowzaStreamingEngine/content/${userLogin}/${folderName}" -type f \\( -name "*.tmp" -o -name "*.part" -o -size 0 \\) -delete 2>/dev/null || true`;
      await SSHManager.executeCommand(serverId, cleanupCommand);
      
      // Definir permissões corretas
      const folderPath = `/usr/local/WowzaStreamingEngine/content/${userLogin}/${folderName}`;
      await SSHManager.executeCommand(serverId, `chmod -R 755 "${folderPath}"`);
      await SSHManager.executeCommand(serverId, `chown -R wowza:wowza "${folderPath}"`);
      
      console.log(`✅ Pasta ${folderName} sincronizada com servidor`);
      
      res.json({
        success: true,
        message: 'Pasta sincronizada com sucesso',
        folder_name: folderName,
        server_path: folderPath
      });
    } catch (sshError) {
      console.error('Erro na sincronização:', sshError);
      res.status(500).json({ 
        error: 'Erro ao sincronizar pasta com servidor',
        details: sshError.message 
      });
    }
  } catch (err) {
    console.error('Erro na sincronização da pasta:', err);
    res.status(500).json({ error: 'Erro na sincronização da pasta', details: err.message });
  }
});

module.exports = router;