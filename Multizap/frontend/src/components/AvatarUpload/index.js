import React, { useContext, useState, useEffect } from 'react';
import Avatar from '@material-ui/core/Avatar';
import makeStyles from '@material-ui/core/styles/makeStyles';
import Button from '@material-ui/core/Button';
import CloudUploadIcon from '@material-ui/icons/CloudUpload';
import Box from '@material-ui/core/Box';
import { AuthContext } from '../../context/Auth/AuthContext';

const useStyles = makeStyles((theme) => ({
  avatar: {
    width: theme.spacing(12),
    height: theme.spacing(12),
    margin: theme.spacing(2),
    cursor: 'pointer',
    borderRadius: '50%',
    border: '2px solid #ccc',
  },
}));

const AvatarUploader = ({ setAvatar, avatar }) => {
  const classes = useStyles();
  const [selectedFile, setSelectedFile] = useState(null);
  const [previewImage, setPreviewImage] = useState(null);
  const { user } = useContext(AuthContext);

  useEffect(() => {
    if (avatar && !selectedFile) {
      setPreviewImage(null);
    }
  }, [avatar, selectedFile]);

  const handleFileChange = (event) => {
    const file = event.target.files[0];
    setSelectedFile(file);
    setAvatar(file);

    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        setPreviewImage(reader.result);
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <Box display="flex" flexDirection="column" alignItems="center">
      {!previewImage && avatar ? (
        <Avatar
          key={avatar || 'default'}
          src={`${process.env.REACT_APP_BACKEND_URL}/public/avatar/${avatar}?v=${new Date().getTime()}`}
          style={{ width: 120, height: 120 }}
          className={classes.avatar}
        />
      ) : !avatar && !previewImage ? (
        <Avatar
          key="noimage"
          src={`${process.env.REACT_APP_BACKEND_URL}/public/app/noimage.png`}
          style={{ width: 120, height: 120 }}
          className={classes.avatar}
        />
      ) : (
        <Avatar
          key="preview"
          alt="Preview Avatar"
          src={previewImage ? previewImage : user.avatar}
          style={{ width: 120, height: 120 }}
          className={classes.avatar}
        />
      )}

      <input
        accept="image/*"
        type="file"
        id="avatar-upload"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
      <label htmlFor="avatar-upload" style={{ marginTop: 10 }}>
        <Button
          variant="contained"
          component="span"
          startIcon={<CloudUploadIcon />}
        >
          Upload Avatar
        </Button>
      </label>
    </Box>
  );
};

export default AvatarUploader;
